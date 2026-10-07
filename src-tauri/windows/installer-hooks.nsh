; Windows shell integration for the NSIS installer.
;
; The MSI (WiX) path is the primary installer and uses windows/shell-integration.wxs.
; These hooks keep an NSIS build equivalent so both installers register the same
; handlers. Tauri runs NSIS_HOOK_POSTINSTALL after files are installed and
; NSIS_HOOK_PREUNINSTALL before removal. The bundled executable is
; $INSTDIR\typsastra.exe (the Cargo binary name).

!macro TypsastraRegisterShellIntegration
  ; .typ -> Typsastra as the default HKCR handler and an "Open with" entry.
  WriteRegStr HKCR ".typ" "" "Typsastra.TypstSource"
  WriteRegStr HKCR ".typ\OpenWithProgids" "Typsastra.TypstSource" ""
  WriteRegStr HKCR "Typsastra.TypstSource" "" "Typst Document"
  WriteRegStr HKCR "Typsastra.TypstSource" "FriendlyTypeName" "Typst Document"
  WriteRegStr HKCR "Typsastra.TypstSource\DefaultIcon" "" "$INSTDIR\typsastra.exe,0"
  WriteRegStr HKCR "Typsastra.TypstSource\shell\open\command" "" '"$INSTDIR\typsastra.exe" "%1"'

  ; .md -> Typsastra as the default HKCR handler and an "Open with" entry.
  WriteRegStr HKCR ".md" "" "Typsastra.Markdown"
  WriteRegStr HKCR ".md\OpenWithProgids" "Typsastra.Markdown" ""
  WriteRegStr HKCR "Typsastra.Markdown" "" "Markdown Document"
  WriteRegStr HKCR "Typsastra.Markdown" "FriendlyTypeName" "Markdown Document"
  WriteRegStr HKCR "Typsastra.Markdown\DefaultIcon" "" "$INSTDIR\typsastra.exe,0"
  WriteRegStr HKCR "Typsastra.Markdown\shell\open\command" "" '"$INSTDIR\typsastra.exe" "%1"'

  ; Application registration drives the Windows "Open with" list.
  WriteRegStr HKCR "Applications\typsastra.exe" "FriendlyAppName" "Typsastra"
  WriteRegStr HKCR "Applications\typsastra.exe\SupportedTypes" ".typ" ""
  WriteRegStr HKCR "Applications\typsastra.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCR "Applications\typsastra.exe\DefaultIcon" "" "$INSTDIR\typsastra.exe,0"
  WriteRegStr HKCR "Applications\typsastra.exe\shell\open\command" "" '"$INSTDIR\typsastra.exe" "%1"'

  ; "Open with Typsastra" for folders and folder backgrounds.
  WriteRegStr HKCR "Directory\shell\Typsastra" "" "Open with Typsastra"
  WriteRegStr HKCR "Directory\shell\Typsastra" "Icon" "$INSTDIR\typsastra.exe,0"
  WriteRegStr HKCR "Directory\shell\Typsastra\command" "" '"$INSTDIR\typsastra.exe" "%1"'
  WriteRegStr HKCR "Directory\Background\shell\Typsastra" "" "Open with Typsastra"
  WriteRegStr HKCR "Directory\Background\shell\Typsastra" "Icon" "$INSTDIR\typsastra.exe,0"
  WriteRegStr HKCR "Directory\Background\shell\Typsastra\command" "" '"$INSTDIR\typsastra.exe" "%V"'
!macroend

!macro TypsastraUnregisterShellIntegration
  DeleteRegKey HKCR "Directory\Background\shell\Typsastra"
  DeleteRegKey HKCR "Directory\shell\Typsastra"
  DeleteRegKey HKCR "Applications\typsastra.exe"
  ; Only remove the file associations and ProgIds when they still point at
  ; Typsastra, so an uninstall never deletes another editor's registration.
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
