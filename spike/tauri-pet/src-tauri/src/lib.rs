//! Spike: can Tauri 2 + the system WebView host the desktop cat's window?
//!
//! The Electron cat leans on one Electron-specific trick above all others:
//!
//!     win.setIgnoreMouseEvents(true, { forward: true })
//!
//! A click-through window that *still* receives mouse-move events, so the renderer
//! can per-pixel hit test the sprite and ask the main process to take the mouse back
//! the moment the cursor is over actual cat. Tauri has `set_ignore_cursor_events`,
//! but no forwarding: once it is on, the webview hears nothing. This spike rebuilds
//! that loop the only way left -- poll the cursor in Rust, hand the position to the
//! webview, let it answer hit or miss, toggle click-through from the answer -- and
//! then measures whether the round trip is quick enough to feel like the Electron
//! version.
//!
//! Run `tauri-pet.exe --selftest` and it drives the real cursor through three
//! positions and prints PASS/FAIL to stdout, so the answer is evidence rather than
//! "it compiled". The checks mirror the ones in electron/_smoke.js:
//!
//!   * cursor on the cat's body    -> renderer reports a hit, window takes the mouse
//!   * cursor on a transparent     -> no hit, window is click-through again
//!     corner of the cat's canvas     (this is the check that catches a lazy
//!                                     bounding-box hit test)
//!   * cursor far away             -> no hit, click-through
//!
//! Without the flag it just runs, with an on-screen HUD, so click-through can also
//! be judged by hand -- which is the only way to judge how it *feels*.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
    menu::{ContextMenu, Menu, MenuItem},
    tray::TrayIconBuilder,
};

/// Window label. Must match `capabilities/default.json`.
const PET: &str = "pet";

/// Cursor poll rate. The ceiling on how fast the renderer can learn the cursor
/// moved, and therefore on how late the window can be in taking the mouse back.
const POLL_HZ: u64 = 60;

/// The cat's box, logical px. Rust owns this number rather than the renderer so the
/// self-test knows exactly where to aim the cursor.
const CAT: f64 = 160.0;

/// What the renderer needs to lay itself out: the work area in logical px plus where
/// the cat's canvas goes inside it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    width: f64,
    height: f64,
    scale: f64,
    cat: f64,
    cat_left: f64,
}

/// A polled cursor position, in the window's own logical coordinates -- the same
/// space the renderer's canvas lives in, so it can hit test without converting.
#[derive(Clone, Serialize)]
struct Cursor {
    x: f64,
    y: f64,
    seq: u64,
}

/// The renderer's view of itself, pushed back every 100 ms. `invoke_*` are measured
/// in the renderer around the `set_interactive` call, which is the part of the loop
/// Electron did not have.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    hit: bool,
    interactive: bool,
    events: u64,
    rate: f64,
    invoke_avg: f64,
    invoke_p95: f64,
    toggles: u64,
    clicks: u64,
}

#[derive(Default)]
struct Shared {
    latest: Mutex<Option<Report>>,
    menu: Mutex<Option<Menu<Wry>>>,
}

#[tauri::command]
fn stage(window: WebviewWindow) -> Result<Stage, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    Ok(Stage {
        width,
        height,
        scale,
        cat: CAT,
        cat_left: ((width - CAT) / 2.0).round(),
    })
}

/// The whole point of the spike. `ignore == !interactive`.
#[tauri::command]
fn set_interactive(window: WebviewWindow, interactive: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(!interactive)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn report(shared: State<Shared>, report: Report) {
    *shared.latest.lock().unwrap() = Some(report);
}

/// Right-clicking the cat pops the same native menu the tray uses, the way
/// `buildMenu()` is shared in electron/main.js.
#[tauri::command]
fn open_menu(app: tauri::AppHandle, shared: State<Shared>) -> Result<(), String> {
    let menu = shared.menu.lock().unwrap().clone();
    let (Some(menu), Some(webview)) = (menu, app.get_webview_window(PET)) else {
        return Err("no menu or no window".into());
    };
    // `ContextMenu::popup` wants the plain Window, which lives one hop below the
    // WebviewWindow wrapper.
    menu.popup(webview.as_ref().window())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn log(line: String) {
    println!("  renderer  {line}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let selftest = std::env::args().any(|a| a == "--selftest");

    tauri::Builder::default()
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![
            stage,
            set_interactive,
            report,
            open_menu,
            log
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // ---- the window ------------------------------------------------------
            //
            // Sized to the *work area*, not the whole display: that is what keeps the
            // cat sitting on top of the taskbar instead of behind it. Electron hands
            // this over as `screen.getPrimaryDisplay().workArea`; in Tauri it is
            // Monitor::work_area, which does exist -- one of the four risks in the
            // port, now closed.
            let monitor = handle
                .primary_monitor()?
                .ok_or("no primary monitor")?;
            let area = *monitor.work_area();

            let window = WebviewWindowBuilder::new(&handle, PET, WebviewUrl::App("index.html".into()))
                .title("desktop cat (tauri spike)")
                .transparent(true)
                .decorations(false)
                .resizable(false)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .focused(false)
                .inner_size(
                    area.size.width as f64 / monitor.scale_factor(),
                    area.size.height as f64 / monitor.scale_factor(),
                )
                .position(
                    area.position.x as f64 / monitor.scale_factor(),
                    area.position.y as f64 / monitor.scale_factor(),
                )
                .build()?;

            // Physical placement, exactly on the work area. Done after build because
            // the logical round trip above can land a pixel off on fractional scaling.
            window.set_position(PhysicalPosition::new(area.position.x, area.position.y))?;
            window.set_size(PhysicalSize::new(area.size.width, area.size.height))?;
            window.set_ignore_cursor_events(true)?;

            println!(
                "window    work area {}x{} at ({}, {}), scale {}",
                area.size.width,
                area.size.height,
                area.position.x,
                area.position.y,
                monitor.scale_factor()
            );

            // ---- tray + native menu ---------------------------------------------
            let hello = MenuItem::with_id(&handle, "hello", "Say hello", true, None::<&str>)?;
            let quit = MenuItem::with_id(&handle, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(&handle, &[&hello, &quit])?;
            app.state::<Shared>()
                .menu
                .lock()
                .unwrap()
                .replace(menu.clone());

            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .ok_or("no default window icon")?
                        .clone(),
                )
                .tooltip("desktop cat (tauri spike)")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    other => println!("  tray      menu event: {other}"),
                })
                .build(app)?;
            println!("tray      icon + native menu built");

            // ---- the cursor loop -------------------------------------------------
            //
            // This is the replacement for `forward: true`. Only emits on movement, so
            // a still cursor costs nothing.
            let poll = handle.clone();
            std::thread::spawn(move || {
                let tick = Duration::from_millis(1000 / POLL_HZ);
                let mut seq = 0u64;
                let mut last = (f64::NAN, f64::NAN);
                loop {
                    std::thread::sleep(tick);
                    let Some(window) = poll.get_webview_window(PET) else {
                        continue;
                    };
                    let (Ok(cursor), Ok(origin), Ok(scale)) = (
                        window.cursor_position(),
                        window.outer_position(),
                        window.scale_factor(),
                    ) else {
                        continue;
                    };
                    let x = (cursor.x - origin.x as f64) / scale;
                    let y = (cursor.y - origin.y as f64) / scale;
                    if (x, y) == last {
                        continue;
                    }
                    last = (x, y);
                    seq += 1;
                    let _ = window.emit("cursor", Cursor { x, y, seq });
                }
            });

            if selftest {
                let test = handle.clone();
                std::thread::spawn(move || {
                    let code = run_selftest(&test, area);
                    test.exit(code);
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Drives the real cursor and checks what the window and the renderer do about it.
/// Windows only: it needs SetCursorPos and the extended window styles.
#[cfg(windows)]
fn run_selftest(
    app: &tauri::AppHandle,
    area: tauri::PhysicalRect<i32, u32>,
) -> i32 {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, SendInput,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, SetCursorPos, WS_EX_LAYERED, WS_EX_TOPMOST,
        WS_EX_TRANSPARENT,
    };

    let mut failures = 0;
    let mut check = |name: &str, ok: bool, detail: String| {
        println!(
            "{}  {:<34} {}",
            if ok { "PASS" } else { "FAIL" },
            name,
            detail
        );
        if !ok {
            failures += 1;
        }
    };

    let Some(window) = app.get_webview_window(PET) else {
        println!("FAIL  window missing");
        return 1;
    };
    let shared = app.state::<Shared>();

    // Give the webview time to boot and send its first report.
    let waited = Instant::now();
    while shared.latest.lock().unwrap().is_none() && waited.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if shared.latest.lock().unwrap().is_none() {
        println!("FAIL  renderer never reported in (20s)");
        return 1;
    }
    println!("      renderer up after {:?}", waited.elapsed());

    let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    let ex_style = |bit: u32| -> bool {
        if hwnd == 0 {
            return false;
        }
        let style = unsafe { GetWindowLongPtrW(HWND(hwnd as _), GWL_EXSTYLE) } as u32;
        style & bit != 0
    };

    check(
        "window is topmost",
        ex_style(WS_EX_TOPMOST.0),
        "WS_EX_TOPMOST".into(),
    );
    check(
        "window is layered (transparency)",
        ex_style(WS_EX_LAYERED.0),
        "WS_EX_LAYERED".into(),
    );

    let geometry = (window.outer_position(), window.inner_size());
    if let (Ok(pos), Ok(size)) = geometry {
        check(
            "window covers the work area",
            pos.x == area.position.x
                && pos.y == area.position.y
                && size.width == area.size.width
                && size.height == area.size.height,
            format!(
                "{}x{}@({},{}) vs work area {}x{}@({},{})",
                size.width,
                size.height,
                pos.x,
                pos.y,
                area.size.width,
                area.size.height,
                area.position.x,
                area.position.y
            ),
        );
    }

    let scale = window.scale_factor().unwrap_or(1.0);
    let logical_height = area.size.height as f64 / scale;
    let logical_width = area.size.width as f64 / scale;
    let cat_left = ((logical_width - CAT) / 2.0).round();

    // Screen pixels for three aims: the middle of the cat's body, a corner of its
    // canvas that is transparent padding, and somewhere else entirely.
    let screen = |lx: f64, ly: f64| -> (i32, i32) {
        (
            area.position.x + (lx * scale).round() as i32,
            area.position.y + (ly * scale).round() as i32,
        )
    };
    let body = screen(cat_left + CAT / 2.0, logical_height - CAT / 2.0);
    let corner = screen(cat_left + 3.0, logical_height - CAT + 3.0);
    let away = screen(10.0, logical_height / 2.0);

    let probe = |at: (i32, i32)| -> Report {
        unsafe {
            let _ = SetCursorPos(at.0, at.1);
        }
        // One poll tick, one IPC round trip, one report interval -- 400 ms is
        // generous on purpose; the latency numbers below are the real measurement.
        std::thread::sleep(Duration::from_millis(400));
        shared.latest.lock().unwrap().clone().unwrap_or_default()
    };

    let on_body = probe(body);
    check(
        "cursor on body -> hit",
        on_body.hit && on_body.interactive,
        format!("hit={} interactive={}", on_body.hit, on_body.interactive),
    );
    check(
        "cursor on body -> window takes mouse",
        !ex_style(WS_EX_TRANSPARENT.0),
        "WS_EX_TRANSPARENT clear".into(),
    );

    let on_corner = probe(corner);
    check(
        "transparent corner -> no hit",
        !on_corner.hit && !on_corner.interactive,
        format!("hit={} interactive={}", on_corner.hit, on_corner.interactive),
    );
    check(
        "transparent corner -> click-through",
        ex_style(WS_EX_TRANSPARENT.0),
        "WS_EX_TRANSPARENT set".into(),
    );

    let far = probe(away);
    check(
        "cursor away -> click-through",
        !far.hit && ex_style(WS_EX_TRANSPARENT.0),
        format!("hit={} WS_EX_TRANSPARENT set", far.hit),
    );

    // ---- a real click, on the body, while the window has the mouse ---------------
    //
    // Three jumped positions prove the toggle flips; they do not prove a *click*
    // survives the trip. This does: the renderer only ever increments its counter
    // from a mousedown it actually received.
    let before = probe(body).clicks;
    unsafe {
        let mut down = INPUT::default();
        down.r#type = INPUT_MOUSE;
        down.Anonymous.mi = MOUSEINPUT {
            dwFlags: MOUSEEVENTF_LEFTDOWN,
            ..Default::default()
        };
        let mut up = INPUT::default();
        up.r#type = INPUT_MOUSE;
        up.Anonymous.mi = MOUSEINPUT {
            dwFlags: MOUSEEVENTF_LEFTUP,
            ..Default::default()
        };
        SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32);
    }
    std::thread::sleep(Duration::from_millis(400));
    let clicked = shared.latest.lock().unwrap().clone().unwrap_or_default();
    check(
        "click on the cat reaches the renderer",
        clicked.clicks > before,
        format!("clicks {} -> {}", before, clicked.clicks),
    );

    // ---- how it feels: a continuous sweep through the cat and out ----------------
    //
    // The jumps above only move the cursor three times, which is far too few samples
    // to say anything about latency. This drags it across the body at roughly mouse
    // speed, in and out of the sprite, so the poll loop, the hit test and the
    // click-through toggle all run at the rate a hand would drive them.
    let sweep_from = screen(cat_left - 40.0, logical_height - CAT / 2.0);
    let sweep_to = screen(cat_left + CAT + 40.0, logical_height - CAT / 2.0);
    let steps = 120;
    let sweep_started = Instant::now();
    for i in 0..=steps {
        let t = f64::from(i) / f64::from(steps);
        let x = sweep_from.0 as f64 + (sweep_to.0 - sweep_from.0) as f64 * t;
        unsafe {
            let _ = SetCursorPos(x.round() as i32, sweep_from.1);
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    let sweep_elapsed = sweep_started.elapsed();
    std::thread::sleep(Duration::from_millis(400));
    let swept = shared.latest.lock().unwrap().clone().unwrap_or_default();

    check(
        "sweep kept the loop fed",
        swept.rate >= 30.0,
        format!("{:.0} cursor events/s during the sweep", swept.rate),
    );
    check(
        "sweep toggled the mouse both ways",
        swept.toggles >= 2 && !swept.hit,
        format!(
            "{} toggles, ended hit={} click-through={}",
            swept.toggles,
            swept.hit,
            ex_style(WS_EX_TRANSPARENT.0)
        ),
    );
    check(
        "round trip stays inside a frame",
        swept.invoke_p95 <= 16.7,
        format!(
            "set_interactive avg {:.1} ms, p95 {:.1} ms",
            swept.invoke_avg, swept.invoke_p95
        ),
    );

    println!(
        "      swept {:.0} px in {:?}: {} cursor events total, {:.0}/s, {} toggles",
        (sweep_to.0 - sweep_from.0) as f64,
        sweep_elapsed,
        swept.events,
        swept.rate,
        swept.toggles
    );
    println!(
        "{}",
        if failures == 0 {
            "SPIKE OK  all window behaviours reproduced"
        } else {
            "SPIKE FAILED"
        }
    );

    i32::from(failures > 0)
}

#[cfg(not(windows))]
fn run_selftest(_app: &tauri::AppHandle, _area: tauri::PhysicalRect<i32, u32>) -> i32 {
    println!("      --selftest drives the cursor through Win32; run it on Windows");
    0
}

// Keeps the logical-unit imports honest if the builder calls above are ever
// switched back to logical placement.
#[allow(dead_code)]
fn _unused(_: LogicalPosition<f64>, _: LogicalSize<f64>) {}
