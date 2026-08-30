; Rendered by electron-builder into the generated NSIS script via "build.nsis.include".
; Kill any running MTask process so install/upgrade no longer abort with a
; "MTask cannot be closed" prompt.
;
; Why /T: the app spawns an embedded server as MTask.exe too (ELECTRON_RUN_AS_NODE),
; so a single /IM match is not enough - /T also terminates child instances and the
; tree of same-named processes that may have survived a previous hard kill.

!macro customInit
  ; Installer init: force-stop the app tree before files are touched/overwritten.
  nsExec::ExecToLog 'taskkill /F /IM MTask.exe /T'
  Sleep 500
!macroend

!macro customUnInit
  ; Uninstaller init: ensure nothing locks the files/database being removed.
  nsExec::ExecToLog 'taskkill /F /IM MTask.exe /T'
  Sleep 500
!macroend