; galleryLAB installs for the current Windows account only: no administrator
; prompt, and updates never need elevation. (Picked up by electron-builder via
; nsis.include in electron-builder.yml.)
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 0.1.0's setup also offered "Anyone who uses this computer". Installing this
; per-user version next to such a copy would leave two galleryLABs, one of
; which never updates, so ask for the all-users copy to be removed first.
; A per-user install on the same PC still upgrades normally.
!macro customInit
  ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 != ""
  ${andif} $R9 == ""
    MessageBox MB_OK|MB_ICONINFORMATION "galleryLAB is installed for everyone on this PC, in $R8.$\r$\n$\r$\nThis version installs for your account only and keeps itself up to date. Uninstall the copy for everyone first (Settings, Apps, galleryLAB, Uninstall), then run this setup again.$\r$\n$\r$\nYour Library and settings are kept." /SD IDOK
    Quit
  ${endif}
!macroend
