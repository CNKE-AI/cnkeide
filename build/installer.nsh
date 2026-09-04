; CnkeIDE NSIS 自定义安装脚本
; 1.2.2 新增：清理旧的 cnke-claw-updater 目录（双 productName 冲突根除）

!macro customInstall
  DetailPrint "正在清理旧版本残留..."

  ; 【重要】切勿删除 $LOCALAPPDATA\cnke-claw-updater 目录！
  ; 该目录是 electron-updater 的差分更新缓存（updaterCacheDirName=cnke-claw-updater），
  ; electron-builder 的 installApplicationFiles 会在本宏执行前，把当前安装包复制到
  ; 该目录下的 installer.exe 作为下次差分更新的拼装基准。
  ; 1.2.2 时代曾在此 RMDir /r 该目录，导致每次更新都丢失基准 → 退化为全量 ~86MB。
  ; 故此处只清理真正的 Squirrel 旧残留（cnke-claw 时代的目录，与差分基准无关）。

  ; 清理 Squirrel 旧残留目录（1.2.1 及更早 productName=cnke-claw 时代遗留）
  SetShellVarContext current
  StrCpy $0 "$LOCALAPPDATA\cnke-claw"
  ${If} ${FileExists} "$0\*.*"
    RMDir /r "$0"
    DetailPrint "已清理旧 Squirrel 目录: $0"
  ${EndIf}

  DetailPrint "安装准备完成"
!macroend

; 卸载时同样清理（避免重装时残留）
!macro customUnInstall
  DetailPrint "正在清理 CnkeIDE 残留..."

  ; 清理 updater 目录
  SetShellVarContext current
  StrCpy $0 "$LOCALAPPDATA\cnkeide-updater"
  ${If} ${FileExists} "$0\*.*"
    RMDir /r "$0"
  ${EndIf}

  ; 不删 cnke-claw-updater（可能是别的产品用），保持保守

  ; 清理用户数据（可选，默认保留）
  ; StrCpy $0 "$APPDATA\cnke-claw"
  ; ${If} ${FileExists} "$0\*.*"
  ;   RMDir /r "$0"
  ; ${EndIf}
!macroend
