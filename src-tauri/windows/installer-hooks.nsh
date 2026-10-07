; Windows shell integration for the NSIS installer.
;
; The MSI (WiX) path is the primary installer and uses windows/shell-integration.wxs.
; These hooks keep a future NSIS build equivalent so both installers register the
; same handlers. Tauri runs NSIS_HOOK_POSTINSTALL after files are installed and
; NSIS_HOOK_PREUNINSTALL before removal.

!macro TypsastraRegisterShellIntegration
  ; .typ -> Typsastra as the default HKCR handler.
  WriteRegStr HKCR ".typ" "" "Typsastra.TypstSource"
  WriteRegStr HKCR "Typsastra.TypstSource" "" "Typst Document"
  WriteRegStr HKCR "Typsastra.TypstSource" "FriendlyTypeName" "Typst Document"
  WriteRegStr HKCR "Typsastra.TypstSource\DefaultIcon" "" "$INSTDIR\Typsastra.exe,0"
  WriteRegStr HKCR "Typsastra.TypstSource\shell\open\command" "" '"$INSTDIR\Typsastra.exe" "%1"'

  ; .md -> Typsastra as the default HKCR handler.
  WriteRegStr HKCR ".md" "" "Typsastra.Markdown"
  WriteRegStr HKCR "Typsastra.Markdown" "" "Markdown Document"
  WriteRegStr HKCR "Typsastra.Markdown" "FriendlyTypeName" "Markdown Document"
  WriteRegStr HKCR "Typsastra.Markdown\DefaultIcon" "" "$INSTDIR\Typsastra.exe,0"
  WriteRegStr HKCR "Typsastra.Markdown\shell\open\command" "" '"$INSTDIR\Typsastra.exe" "%1"'

  ; "Open with Typsastra" for folders and folder backgrounds.
  WriteRegStr HKCR "Directory\shell\Typsastra" "" "Open with Typsastra"
  WriteRegStr HKCR "Directory\shell\Typsastra" "Icon" "$INSTDIR\Typsastra.exe,0"
  WriteRegStr HKCR "Directory\shell\Typsastra\command" "" '"$INSTDIR\Typsastra.exe" "%1"'
  WriteRegStr HKCR "Directory\Background\shell\Typsastra" "" "Open with Typsastra"
  WriteRegStr HKCR "Directory\Background\shell\Typsastra" "Icon" "$INSTDIR\Typsastra.exe,0"
  WriteRegStr HKCR "Directory\Background\shell\Typsastra\command" "" '"$INSTDIR\Typsastra.exe" "%V"'
!macroend

!macro TypsastraUnregisterShellIntegration
  DeleteRegKey HKCR "Directory\Background\shell\Typsastra"
  DeleteRegKey HKCR "Directory\shell\Typsastra"
  ; Only remove the file associations when they still point at Typsastra, so an
  ; uninstall never deletes another editor's registration.
  ReadRegStr $0 HKCR ".typ" ""
  StrCmp $0 "Typsastra.TypstSource" 0 +2
    DeleteRegKey HKCR ".typ"
  ReadRegStr $0 HKCR ".md" ""
  StrCmp $0 "Typsastra.Markdown" 0 +2
    DeleteRegKey HKCR ".md"
  DeleteRegKey HKCR "Typsastra.TypstSource"
  DeleteRegKey HKCR "Typsastra.Markdown"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro TypsastraRegisterShellIntegration
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TypsastraUnregisterShellIntegration
!macroend
