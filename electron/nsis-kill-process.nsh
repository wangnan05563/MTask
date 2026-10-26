; Rendered by electron-builder into the generated NSIS script via "build.nsis.include".
; Kill any running MTask process so install/upgrade no longer abort with a
; "MTask cannot be closed" prompt.
;
; T03298: no /T. /IM already matches every process named MTask.exe system-wide - the app
; and the ELECTRON_RUN_AS_NODE server it spawns are both covered by the name alone. /T adds
; only the process *tree* of those matches, and in the in-app update flow the installer is
; launched by the app, so it sits inside that tree: the installer killed itself during
; .onInit, before the install section ever ran. The app vanished (it was a taskkill target)
; and nothing was installed - "点击立即安装后程序自动关闭，但没有装上新版本".
; The app side has to cooperate: electron/main.js spawns the installer detached, otherwise
; the installer inherits the app's job object and dies with it when this taskkill lands
; (measured matrix: attached installer dies with and without /T; detached + no /T lives).

!macro customInit
  ; Installer init: force-stop the app before files are touched/overwritten.
  nsExec::ExecToLog 'taskkill /F /IM MTask.exe'
  Sleep 500
!macroend

!macro customUnInit
  ; Uninstaller init: ensure nothing locks the files/database being removed.
  nsExec::ExecToLog 'taskkill /F /IM MTask.exe'
  Sleep 500
!macroend
