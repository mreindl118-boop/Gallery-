; galleryLAB installs for the current Windows account only: no administrator
; prompt, and updates never need elevation. (Picked up by electron-builder via
; nsis.include in electron-builder.yml.)
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
