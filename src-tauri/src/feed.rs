//! Feeding the cat your files.
//!
//! A fish from the menu is make-believe and costs nothing; the page handles that on
//! its own. Dropping one of your files on the cat is not: the file is deleted, for
//! good, which is the whole joke and also the reason everything here leans towards
//! saying no. The page never sees the paths and cannot delete anything -- it is told
//! "eat" or "cancelFeed" once a decision has been made here.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::command;

/// How long "stop asking" lasts, and deliberately only in memory: every launch starts
/// by asking again. A pet that silently deletes files is worse than one more dialog.
const SUPPRESS_FOR: Duration = Duration::from_secs(5 * 60);
static SUPPRESS_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

/// One meal at a time. A second drop while a dialog is still up would stack dialogs
/// over a cat that is already waiting for the first answer.
static ASKING: AtomicBool = AtomicBool::new(false);

// Cancel comes first, which makes it the default on both platforms: Enter on Windows
// presses the first button, Return on macOS presses the first-added one, and Escape or
// closing the dialog is Cancel too. The safe answer is the one you get by reflex.
const CANCEL: &str = "Cancel";
const FEED: &str = "Feed it to the cat";
const FEED_QUIETLY: &str = "Feed it, and stop asking for 5 minutes";

struct Asking;

impl Asking {
    fn start() -> Option<Self> {
        (!ASKING.swap(true, Ordering::SeqCst)).then_some(Asking)
    }
}

impl Drop for Asking {
    fn drop(&mut self) {
        ASKING.store(false, Ordering::SeqCst);
    }
}

/// Files were dropped on the cat: check them, ask, delete, then let the cat chew.
pub async fn feed_files(app: &AppHandle, paths: Vec<PathBuf>) {
    let Some(_asking) = Asking::start() else {
        return;
    };

    let mut files: Vec<PathBuf> = Vec::new();
    for path in paths {
        if !files.iter().any(|seen| same(seen, &path)) {
            files.push(path);
        }
    }

    let mut edible = Vec::new();
    let mut refused = Vec::new();
    for file in files {
        match refuse_to_eat(app, &file) {
            Some(why) => refused.push(format!("{} is {why}", name(&file))),
            None => edible.push(file),
        }
    }

    if edible.is_empty() {
        command(app, "cancelFeed", Value::Null);
        if !refused.is_empty() {
            alert(
                MessageLevel::Info,
                "The cat will not eat that.",
                &refused.join("\n"),
                MessageButtons::OkCustom("Fair enough".into()),
            )
            .await;
        }
        return;
    }

    if !suppressed() {
        let (message, detail) = describe_meal(&edible);
        let answer = alert(
            MessageLevel::Warning,
            &message,
            &detail,
            MessageButtons::YesNoCancelCustom(CANCEL.into(), FEED.into(), FEED_QUIETLY.into()),
        )
        .await;
        match answer {
            MessageDialogResult::Custom(label) if label == FEED => {}
            MessageDialogResult::Custom(label) if label == FEED_QUIETLY => suppress(),
            // Cancel, Escape, closing the dialog, or anything unexpected.
            _ => {
                command(app, "cancelFeed", Value::Null);
                return;
            }
        }
    }

    let mut eaten = 0;
    let mut stuck = Vec::new();
    for file in &edible {
        match std::fs::remove_file(file) {
            Ok(()) => {
                eaten += 1;
                println!("cat: ate {}", file.display());
            }
            Err(error) => stuck.push(format!("{}: {error}", name(file))),
        }
    }

    command(app, if eaten > 0 { "eat" } else { "cancelFeed" }, Value::Null);

    if !stuck.is_empty() {
        let message = if eaten > 0 {
            "Some of that would not go down."
        } else {
            "The cat could not eat that."
        };
        alert(MessageLevel::Error, message, &stuck.join("\n"), MessageButtons::Ok).await;
    }
}

/// A native message box with no parent window.
///
/// Parentless on purpose: the cat's window is not focusable, and a modal attached to
/// a window that cannot take focus is a fine way to produce a dialog nobody can answer.
async fn alert(
    level: MessageLevel,
    message: &str,
    detail: &str,
    buttons: MessageButtons,
) -> MessageDialogResult {
    let dialog = AsyncMessageDialog::new().set_level(level).set_buttons(buttons);

    // macOS shows the title as the alert's bold headline; Windows shows it in the
    // caption bar, where the app's name belongs and the question would be cut off.
    #[cfg(target_os = "macos")]
    let dialog = dialog.set_title(message).set_description(detail);
    #[cfg(not(target_os = "macos"))]
    let dialog = dialog
        .set_title("Desktop Cat")
        .set_description(format!("{message}\n\n{detail}"));

    dialog.show().await
}

fn suppressed() -> bool {
    let until = *SUPPRESS_UNTIL.lock().unwrap();
    until.is_some_and(|until| Instant::now() < until)
}

fn suppress() {
    *SUPPRESS_UNTIL.lock().unwrap() = Some(Instant::now() + SUPPRESS_FOR);
}

// ---- what the cat will not eat ------------------------------------------------------

/// Why the cat must not eat this, or `None` if it may.
///
/// Eating is an unrecoverable delete, so this errs towards refusing. Folders are out
/// entirely -- "the cat ate my whole project" is not a feature -- along with anything
/// belonging to the operating system or to the app itself.
fn refuse_to_eat(app: &AppHandle, target: &Path) -> Option<&'static str> {
    if target.parent().is_none() {
        return Some("a whole drive");
    }

    if own_places(app)
        .iter()
        .any(|dir| same(target, dir) || inside(target, dir))
    {
        return Some("part of Desktop Cat itself");
    }

    // `inside(home, target)` rather than the other way round: this is the check that
    // catches C:\Users and /Users, the folders that *contain* the home folder.
    if let Ok(home) = app.path().home_dir() {
        if same(target, &home) || inside(&home, target) {
            return Some("your home folder");
        }
    }

    if system_places()
        .iter()
        .any(|dir| same(target, dir) || inside(target, dir))
    {
        return Some("inside a system folder");
    }

    // Not following links: a dropped shortcut or symlink is eaten itself, never
    // whatever it points at.
    match std::fs::symlink_metadata(target) {
        Err(_) => Some("not there any more"),
        Ok(meta) if meta.is_dir() => Some("a folder, and the cat only eats one file at a time"),
        Ok(_) => None,
    }
}

/// Where Desktop Cat itself lives.
fn own_places(app: &AppHandle) -> Vec<PathBuf> {
    let mut places = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        places.push(dir);
    }
    if let Ok(dir) = app.path().resource_dir() {
        places.push(dir);
    }
    // In a dev build the app is the whole project checkout, the way Electron's app
    // path used to be. Feeding the cat its own source is a bad afternoon.
    #[cfg(debug_assertions)]
    if let Some(project) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        places.push(project.to_path_buf());
    }
    places
}

fn system_places() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect()
    }
    #[cfg(not(windows))]
    {
        // /private as well as /etc and /var: on macOS those are links into it, and a
        // dropped path arrives already resolved.
        [
            "/System",
            "/Library",
            "/usr",
            "/bin",
            "/sbin",
            "/etc",
            "/private",
            "/Applications",
        ]
        .iter()
        .map(PathBuf::from)
        .collect()
    }
}

/// A path as comparable components.
///
/// Case-folded, because both NTFS and macOS's default APFS are case-insensitive -- on
/// a case-sensitive volume that only ever makes the cat refuse *more*. Windows'
/// `\\?\` verbatim prefix is dropped so a canonicalised path still matches its plain
/// spelling.
fn key(path: &Path) -> Vec<String> {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    let text = text
        .strip_prefix(r"\\?\")
        .unwrap_or(text.as_ref())
        .replace('/', "\\");
    #[cfg(not(windows))]
    let text = text.into_owned();

    Path::new(&text)
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

fn same(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

/// Is `target` strictly inside `dir`?
fn inside(target: &Path, dir: &Path) -> bool {
    let (target, dir) = (key(target), key(dir));
    target.len() > dir.len() && target.starts_with(&dir)
}

// ---- what the confirmation says -----------------------------------------------------

fn name(file: &Path) -> String {
    file.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| file.display().to_string())
}

fn format_size(bytes: u64) -> String {
    const K: f64 = 1024.0;
    let b = bytes as f64;
    if b >= K * K * K {
        format!("{:.1} GB", b / (K * K * K))
    } else if b >= K * K {
        format!("{:.1} MB", b / (K * K))
    } else if b >= K {
        format!("{} KB", (b / K).round())
    } else {
        format!("{bytes} bytes")
    }
}

/// The headline and the small print for the confirmation.
fn describe_meal(files: &[PathBuf]) -> (String, String) {
    let total: u64 = files
        .iter()
        .filter_map(|file| std::fs::symlink_metadata(file).ok())
        .map(|meta| meta.len())
        .sum();

    let mut shown: Vec<String> = files
        .iter()
        .take(4)
        .map(|file| format!("  {}", file.display()))
        .collect();
    if files.len() > shown.len() {
        shown.push(format!("  …and {} more", files.len() - shown.len()));
    }

    let message = if files.len() == 1 {
        format!("Feed “{}” to the cat?", name(&files[0]))
    } else {
        format!("Feed {} files to the cat?", files.len())
    };

    let bin = if cfg!(target_os = "macos") {
        "the Bin"
    } else {
        "the Recycle Bin"
    };
    let detail = format!(
        "{}\n\n{} in total. The cat eats it for good: this deletes the file outright \
         rather than moving it to {bin}, and there is nothing to undo afterwards.",
        shown.join("\n"),
        format_size(total),
    );

    (message, detail)
}
