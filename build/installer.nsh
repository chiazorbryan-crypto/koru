; Uninstalling Koru (not updating it) also puts the taskbar back to normal and stops the taskbar helper.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$APPDATA\Koru\taskbar\koru-taskbar.exe" 0 +2
      ExecWait '"$APPDATA\Koru\taskbar\koru-taskbar.exe" disable'
  ${endIf}
!macroend
