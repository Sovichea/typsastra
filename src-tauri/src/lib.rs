use tauri::menu::{Menu, Submenu, MenuItem, PredefinedMenuItem};
use tauri::{ipc::Response, Emitter};
use std::process::Command;
use std::fs::File;
use std::io::Write;
use tempfile::tempdir;

#[tauri::command]
async fn compile_typst_document(source_code: String) -> Result<Response, String> {
    let dir = tempdir().map_err(|e| format!("Failed to create isolated environment: {}", e))?;
    let input_path = dir.path().join("document.typ");
    let output_path = dir.path().join("document.pdf");

    let mut file = File::create(&input_path).map_err(|e| format!("IO Failure: {}", e))?;
    file.write_all(source_code.as_bytes()).map_err(|e| format!("Buffer Flush Failure: {}", e))?;

    let output = Command::new("typst")
        .arg("compile")
        .arg(&input_path)
        .arg(&output_path)
        .output()
        .map_err(|e| format!("Host binary execution blocked: {}", e))?;

    if !output.status.success() {
        let stderr_string = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr_string);
    }

    let pdf_bytes = std::fs::read(&output_path).map_err(|e| format!("Artifact collection failed: {}", e))?;
    Ok(Response::new(pdf_bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle();
            
            let file_menu = Submenu::with_items(handle, "File", true, &[
                &MenuItem::with_id(handle, "open_folder", "Open Workspace Folder...", true, Some("CmdOrCtrl+O"))?,
                &MenuItem::with_id(handle, "save_file", "Save File", true, Some("CmdOrCtrl+S"))?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::quit(handle, None)?
            ])?;

            let edit_menu = Submenu::with_items(handle, "Edit", true, &[
                &PredefinedMenuItem::undo(handle, None)?,
                &PredefinedMenuItem::redo(handle, None)?,
                &PredefinedMenuItem::cut(handle, None)?,
                &PredefinedMenuItem::copy(handle, None)?,
                &PredefinedMenuItem::paste(handle, None)?,
            ])?;

            let view_menu = Submenu::with_items(handle, "View", true, &[
                &MenuItem::with_id(handle, "toggle_editor_mode", "Switch Workspace Layout (Code / WYSIWYM)", true, Some("CmdOrCtrl+M"))?,
            ])?;

            let menu = Menu::with_items(handle, &[&file_menu, &edit_menu, &view_menu])?;
            app.set_menu(menu)?;

            app.on_menu_event(|app_handle, event| {
                match event.id.as_ref() {
                    "open_folder" => { let _ = app_handle.emit("menu-open-folder", ()); },
                    "save_file" => { let _ = app_handle.emit("menu-save-active", ()); },
                    "toggle_editor_mode" => { let _ = app_handle.emit("menu-toggle-layout", ()); },
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![compile_typst_document])
        .run(tauri::generate_context!())
        .expect("Error initializing Tauri execution engine");
}
