//! Desktop Cat, the native half.
//!
//! Everything the page cannot do for itself: one transparent window spanning the work
//! area, mouse click-through except over the cat's own pixels, the tray icon and its
//! menu, and the one dangerous thing the app does -- eating a dropped file -- which
//! lives in `feed.rs` and never trusts the page with a decision.
//!
//! The page is `src/`, unchanged in spirit from the Electron build. It talks to this
//! file through the `window.pet` bridge in `src/bridge.js`; every command it can call
//! is the `#[tauri::command]` list below, and every event it hears is a `pet:*` emit.
//!
//! The one real behavioural difference from Electron is how the cursor reaches the
//! page. Electron's `setIgnoreMouseEvents(true, { forward: true })` kept delivering
//! mouse moves to a click-through window. Tauri has no forwarding: once a window
//! ignores the cursor, it hears nothing. So the cursor is polled here and handed to
//! the page, which runs the same per-pixel hit test it always did and asks for the
//! mouse back when the pointer is on the cat. The same poll is what keeps a file drag
//! working, so there is now one mechanism where Electron needed two.

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod feed;

use std::error::Error;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, ContextMenu, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};

/// The one window. Must match `capabilities/default.json`.
const PET: &str = "pet";

/// If the page stops reporting while it has the mouse, assume it wedged and hand the
/// mouse back. The window covers the whole work area, so a page that froze mid-hover
/// would otherwise swallow every click on the desktop.
const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(1500);
const WATCHDOG_EVERY: Duration = Duration::from_millis(500);

/// Cursor poll rate. This is the ceiling on how quickly the window can notice the
/// pointer arrived on the cat and take the mouse; 60 Hz keeps that inside a frame.
const CURSOR_EVERY: Duration = Duration::from_millis(16);

/// How often to check whether the work area moved: a taskbar resized or docked
/// elsewhere, a display added, the scale changed.
const LAYOUT_EVERY: Duration = Duration::from_millis(1000);

/// The primary display's work area in physical pixels, and its scale.
///
/// Deliberately the work area and not the whole display: it excludes the taskbar, so
/// the taskbar is never under this window and stays completely usable. Its bottom
/// edge is the floor the cat stands and lands on.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Layout {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

impl Layout {
    fn logical_size(&self) -> (f64, f64) {
        (
            f64::from(self.width) / self.scale,
            f64::from(self.height) / self.scale,
        )
    }
}

struct CatMenu {
    menu: Menu<Wry>,
    pause: CheckMenuItem<Wry>,
}

/// Process-wide state, managed by Tauri.
struct Pet {
    paused: AtomicBool,
    /// Whether the window is currently taking mouse input. Mirrors the window so the
    /// watchdog knows whether a silent page is dangerous or harmless.
    grabbing: AtomicBool,
    last_beat: Mutex<Instant>,
    layout: Mutex<Option<Layout>>,
    menu: Mutex<Option<CatMenu>>,
    /// Whether the drag currently over the window carries files. A drag of text out
    /// of a browser fires the same events with no paths, and is no meal.
    drag_has_files: AtomicBool,
}

impl Pet {
    fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            grabbing: AtomicBool::new(false),
            last_beat: Mutex::new(Instant::now()),
            layout: Mutex::new(None),
            menu: Mutex::new(None),
            drag_has_files: AtomicBool::new(false),
        }
    }
}

// ---- talking to the page ------------------------------------------------------------

/// A menu or tray command, as `{ name, ...data }` -- the shape the page has always
/// taken. `data` must be a JSON object or null.
pub(crate) fn command(app: &AppHandle, name: &str, data: Value) {
    let mut payload = match data {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    payload.insert("name".into(), Value::from(name));
    let _ = app.emit("pet:command", Value::Object(payload));
}

fn current_layout(app: &AppHandle) -> Option<Layout> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let area = monitor.work_area();
    Some(Layout {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
        scale: monitor.scale_factor(),
    })
}

/// Where the cursor is, in the page's own CSS pixels.
fn cursor_on_stage(app: &AppHandle) -> Option<(f64, f64)> {
    let layout = (*app.state::<Pet>().layout.lock().unwrap())?;
    let cursor = app.cursor_position().ok()?;
    Some((
        (cursor.x - f64::from(layout.x)) / layout.scale,
        (cursor.y - f64::from(layout.y)) / layout.scale,
    ))
}

// ---- the mouse ----------------------------------------------------------------------

fn take_mouse(window: &WebviewWindow, pet: &Pet, take: bool) {
    if window.set_ignore_cursor_events(!take).is_ok() {
        pet.grabbing.store(take, Ordering::SeqCst);
    }
}

fn beat(pet: &Pet) {
    *pet.last_beat.lock().unwrap() = Instant::now();
}

// ---- commands the page can call -----------------------------------------------------

#[derive(Clone, Serialize)]
struct Stage {
    width: f64,
    height: f64,
    paused: bool,
}

/// Stage size in CSS pixels, plus whether the cat starts out paused.
#[tauri::command]
fn stage(window: WebviewWindow, pet: State<'_, Pet>) -> Result<Stage, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(Stage {
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        paused: pet.paused.load(Ordering::SeqCst),
    })
}

/// The page's verdict on whether the cursor is over the cat. Only ever `true` while
/// it is on the cat's own pixels, so the desktop under everything else stays usable.
#[tauri::command]
fn set_interactive(window: WebviewWindow, pet: State<'_, Pet>, interactive: bool) {
    beat(&pet);
    take_mouse(&window, &pet, interactive);
}

/// Proof of life while the page holds the mouse. See HEARTBEAT_TIMEOUT.
#[tauri::command]
fn heartbeat(pet: State<'_, Pet>) {
    beat(&pet);
}

/// Right-clicked the cat: the same native menu the tray uses.
///
/// The window is not focusable, so the pet can never steal keystrokes from whatever
/// you are typing in. But Windows only dismisses a popup menu on a click elsewhere if
/// the menu's owner window has focus, so with nothing else done the menu stayed open
/// until something was clicked on the cat itself. Focus is lent for exactly the life
/// of the menu -- `popup` blocks until it closes -- and then handed straight back to
/// whichever window had it.
#[tauri::command]
fn open_menu(window: WebviewWindow, pet: State<'_, Pet>) -> Result<(), String> {
    let Some(menu) = pet.menu.lock().unwrap().as_ref().map(|m| m.menu.clone()) else {
        return Ok(());
    };

    #[cfg(windows)]
    let previous = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };

    let _ = window.set_focusable(true);
    let _ = window.set_focus();
    let shown = menu.popup(window.as_ref().window());
    let _ = window.set_focusable(false);

    #[cfg(windows)]
    if !previous.is_invalid() {
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(previous);
        }
    }

    shown.map_err(|e| e.to_string())
}

// ---- menu and tray ------------------------------------------------------------------

/// One definition, shared by the tray icon and right-clicking the cat itself.
fn build_menu(app: &AppHandle, paused: bool) -> tauri::Result<CatMenu> {
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let separator = || PredefinedMenuItem::separator(app);
    let pause = CheckMenuItem::with_id(app, "pause", "Pause", true, paused, None::<&str>)?;

    let menu = Menu::<Wry>::with_items(
        app,
        &[
            &item("come", "Come here")?,
            &item("walk", "Go for a walk")?,
            &item("feed", "Give a fish")?,
            &separator()?,
            &item("tilt", "Head tilt")?,
            &item("wave", "Wave")?,
            &item("groom", "Groom")?,
            &separator()?,
            &item("sleep", "Nap")?,
            &item("wake", "Wake up")?,
            &separator()?,
            &pause,
            &item("settings", "Settings…")?,
            &separator()?,
            &item("quit", "Quit")?,
        ],
    )?;
    Ok(CatMenu { menu, pause })
}

fn on_menu(app: &AppHandle, event: &MenuEvent) {
    match event.id.as_ref() {
        // Walks over to wherever the mouse is.
        "come" => {
            let x = cursor_on_stage(app).map_or(Value::Null, |(x, _)| json!(x));
            command(app, "come", json!({ "x": x }));
        }
        // No position: the fish drops in next to the cat, wherever that is. The cursor
        // is over by the tray when this is clicked, the last place to put dinner.
        id @ ("walk" | "feed" | "tilt" | "wave" | "groom" | "sleep" | "wake") => {
            command(app, id, Value::Null);
        }
        // Opens (or closes) the in-page Settings panel. It is a view concern, so it
        // rides the same command channel; the page toggles the overlay.
        "settings" => command(app, "settings", Value::Null),
        "pause" => {
            let pet = app.state::<Pet>();
            let paused = !pet.paused.fetch_xor(true, Ordering::SeqCst);
            // Set explicitly rather than trusting the platform's own toggle, so the
            // tick can never disagree with what the cat is actually doing.
            if let Some(menu) = pet.menu.lock().unwrap().as_ref() {
                let _ = menu.pause.set_checked(paused);
            }
            command(app, if paused { "pause" } else { "resume" }, Value::Null);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn build_tray(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let menu = build_menu(app, false)?;

    // The resting sit, cropped to the cat by tools/build_icons.py. Compiled in, so
    // the tray can never come up blank because a file went missing.
    let icon = Image::from_bytes(include_bytes!("../../build/icons/32x32.png"))?;

    let handle = app.clone();
    TrayIconBuilder::with_id("cat")
        .icon(icon)
        .tooltip("Desktop Cat")
        .menu(&menu.menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                command(&handle, "tilt", Value::Null);
            }
        })
        .build(app)?;

    *app.state::<Pet>().menu.lock().unwrap() = Some(menu);
    Ok(())
}

// ---- the window ---------------------------------------------------------------------

fn place(window: &WebviewWindow, layout: Layout) -> tauri::Result<()> {
    window.set_position(PhysicalPosition::new(layout.x, layout.y))?;
    window.set_size(PhysicalSize::new(layout.width, layout.height))
}

fn create_window(app: &AppHandle) -> Result<WebviewWindow, Box<dyn Error>> {
    let layout = current_layout(app).ok_or("no primary display to sit on")?;
    let (width, height) = layout.logical_size();

    let window = WebviewWindowBuilder::new(app, PET, WebviewUrl::App("src/index.html".into()))
        .title("Desktop Cat")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        // Never steals focus from what you are typing in, and stays out of Alt-Tab.
        .focused(false)
        .focusable(false)
        // A click on the cat while another app is active still counts as a click.
        .accept_first_mouse(true)
        // The window is never focused, which is exactly when a WebView would like to
        // throttle requestAnimationFrame and freeze the cat.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .inner_size(width, height)
        .position(
            f64::from(layout.x) / layout.scale,
            f64::from(layout.y) / layout.scale,
        )
        .build()?;

    // Exactly on the work area, in physical pixels. The logical round trip above can
    // land a pixel off on fractional scaling, which would float the cat or sink it.
    place(&window, layout)?;
    window.set_ignore_cursor_events(true)?;
    *app.state::<Pet>().layout.lock().unwrap() = Some(layout);

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::DragDrop(drag) = event {
            on_drag(&handle, drag);
        }
    });

    Ok(window)
}

// ---- file drags ---------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct Drag {
    kind: &'static str,
    x: f64,
    y: f64,
}

fn send_drag(app: &AppHandle, kind: &'static str, (x, y): (f64, f64)) {
    let _ = app.emit("pet:drag", Drag { kind, x, y });
}

/// A file drag over the cat.
///
/// These only ever arrive while the window has the mouse, which is only while the
/// pointer is on the cat's own pixels -- everywhere else the window is invisible to
/// hit testing and the drag goes to whatever is underneath. So a drag that gets here
/// is a drag onto the cat, and the page needs no second hit test.
///
/// The paths themselves never go to the page. It is told where the drag is, so the
/// cat can open its mouth in the right place; what gets eaten is decided in Rust.
fn on_drag(app: &AppHandle, event: &DragDropEvent) {
    let pet = app.state::<Pet>();
    let scale = pet.layout.lock().unwrap().map_or(1.0, |layout| layout.scale);
    let at = |position: &PhysicalPosition<f64>| (position.x / scale, position.y / scale);

    match event {
        DragDropEvent::Enter { paths, position } => {
            let files = !paths.is_empty();
            pet.drag_has_files.store(files, Ordering::SeqCst);
            if files {
                send_drag(app, "over", at(position));
            }
        }
        DragDropEvent::Over { position } => {
            if pet.drag_has_files.load(Ordering::SeqCst) {
                send_drag(app, "over", at(position));
            }
        }
        DragDropEvent::Drop { paths, position } => {
            pet.drag_has_files.store(false, Ordering::SeqCst);
            if paths.is_empty() {
                send_drag(app, "leave", at(position));
                return;
            }
            // Mouth stays open while the user answers the confirmation; feed.rs comes
            // back with "eat" or "cancelFeed".
            send_drag(app, "drop", at(position));
            let handle = app.clone();
            let paths = paths.clone();
            tauri::async_runtime::spawn(async move {
                feed::feed_files(&handle, paths).await;
            });
        }
        DragDropEvent::Leave => {
            if pet.drag_has_files.swap(false, Ordering::SeqCst) {
                send_drag(app, "leave", (0.0, 0.0));
            }
        }
        _ => {}
    }
}

// ---- background loops ---------------------------------------------------------------

/// The replacement for Electron's forwarded mouse moves. Emits only on movement, so a
/// still cursor costs nothing.
fn spawn_cursor_poll(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = (f64::NAN, f64::NAN);
        loop {
            std::thread::sleep(CURSOR_EVERY);
            let Some(point) = cursor_on_stage(&app) else {
                continue;
            };
            if point == last {
                continue;
            }
            last = point;
            let _ = app.emit("pet:cursor", json!({ "x": point.0, "y": point.1 }));
        }
    });
}

/// Hands the mouse back if the page goes quiet while holding it.
fn spawn_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(WATCHDOG_EVERY);
            let pet = app.state::<Pet>();
            if !pet.grabbing.load(Ordering::SeqCst) {
                continue;
            }
            let quiet = pet.last_beat.lock().unwrap().elapsed();
            if quiet <= HEARTBEAT_TIMEOUT {
                continue;
            }
            if let Some(window) = app.get_webview_window(PET) {
                eprintln!("cat: released the mouse, page silent for {quiet:?}");
                take_mouse(&window, &pet, false);
            }
        }
    });
}

/// Follows the work area around: a resized taskbar, a new display, a scale change.
fn spawn_layout_watch(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(LAYOUT_EVERY);
            let Some(now) = current_layout(&app) else {
                continue;
            };
            let pet = app.state::<Pet>();
            if *pet.layout.lock().unwrap() == Some(now) {
                continue;
            }
            let Some(window) = app.get_webview_window(PET) else {
                continue;
            };
            if place(&window, now).is_ok() {
                *pet.layout.lock().unwrap() = Some(now);
                let (width, height) = now.logical_size();
                let _ = app.emit("stage:resized", json!({ "width": width, "height": height }));
            }
        }
    });
}

// ---- lifecycle ----------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        // First, so a second launch exits before it has built anything. The running
        // cat looks up to say it is already here.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            command(app, "tilt", Value::Null);
        }))
        .manage(Pet::new())
        .invoke_handler(tauri::generate_handler![
            stage,
            set_interactive,
            heartbeat,
            open_menu
        ])
        .on_menu_event(|app, event| on_menu(app, &event))
        .setup(|app| {
            // A menu-bar accessory with no Dock tile. Info.plist says the same for
            // the packaged app; this makes `npm start` match.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            create_window(&handle)?;
            build_tray(&handle)?;
            spawn_cursor_poll(handle.clone());
            spawn_watchdog(handle.clone());
            spawn_layout_watch(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Desktop Cat");
}
