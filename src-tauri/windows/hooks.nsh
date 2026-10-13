; Hooks into Tauri's NSIS installer (bundle > windows > nsis > installerHooks).
;
; Desktop Cat up to 1.1 was an Electron app, installed by electron-builder under its
; own uninstall key. This installer knows nothing about that key, so without this hook
; an upgrade would leave the two side by side: two cats on the taskbar, two Start menu
; entries, two rows in Apps & features. The old one is removed before anything new is
; copied.
;
; The key is electron-builder's GUID for the old appId, dev.desktopcat.app -- a UUID v5
; of the appId in electron-builder's namespace, so it never changes. Both hives are
; checked because the old installer let you choose per-user or per-machine.

!define DESKTOPCAT_ELECTRON_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\1dcdd97c-6bdf-5268-97a3-315423b35009"

!macro DESKTOPCAT_REMOVE_ELECTRON ROOT
  ; Tauri's own script uses the R registers around this hook, so leave them as found.
  Push $R0
  Push $R1
  Push $R2

  ReadRegStr $R0 ${ROOT} "${DESKTOPCAT_ELECTRON_KEY}" "QuietUninstallString"
  ReadRegStr $R1 ${ROOT} "${DESKTOPCAT_ELECTRON_KEY}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
    DetailPrint "Removing the previous Desktop Cat (Electron build) from $R1"
    ; QuietUninstallString is the old uninstaller plus /S. `_?=` makes it run in place
    ; instead of copying itself to %TEMP% and returning at once, which is the only way
    ; ExecWait actually waits for it. Without that, the old uninstaller would still be
    ; deleting the "Desktop Cat" shortcuts while this installer was creating new ones
    ; under the same names. The path after `_?=` must stay unquoted, spaces and all.
    ; The old uninstaller stops a running Electron cat itself.
    ExecWait '$R0 _?=$R1' $R2
    ; Run in place, it cannot delete itself. Tidy up the one file it leaves behind,
    ; and the folder if that leaves it empty.
    Delete "$R1\Uninstall Desktop Cat.exe"
    RMDir "$R1"
  ${EndIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro DESKTOPCAT_REMOVE_ELECTRON HKCU
  !insertmacro DESKTOPCAT_REMOVE_ELECTRON HKLM
!macroend
