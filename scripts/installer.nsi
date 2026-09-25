; 摸鱼桌宠 Electron 安装器 —— NSIS 3 脚本。
;
; 设计原则（PACKAGING_PLAN §0.5/§0.6）：最小自定义面 + 行业最标准行为。
;   - per-user 免 UAC（RequestExecutionLevel user），全部注册表写入仅 HKCU
;   - 固定安装目录（无目录选择页）：目录名无空格，开机自启的 Run 值
;     （auto-launch/Electron 写入不带引号）才安全
;   - 卸载器不提供「删除个人数据」选项：业务 DB 在 %APPDATA%\desk-pet\desk-pet.db，
;     与绿色版/Tauri 版共享，默认永远保留（文档给出手动清理方法）
;   - 自启登录项仅在「条目值指向本安装目录」时才删（防误删绿色版同名条目）；
;     误删了也会被绿色版下次启动的对账自愈
;   - 无升级逻辑：升级 = 先卸载再装（使用说明负责讲清）
;
; 运行：npm run pack 先产出 release\摸鱼桌宠-win32-x64\，再 makensis scripts/installer.nsi

Unicode true
!include "MUI2.nsh"
!include "StrFunc.nsh"
${UnStrStr}

!define PRODUCT_NAME "摸鱼桌宠"
!define VERSION "0.1.0"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${PRODUCT_NAME}"
OutFile "..\release\electron\desk-pet-setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\src-tauri\icons\icon.ico"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath "$INSTDIR"

  ; 程序本体（含 exe 被占用时 NSIS 自带的重试对话框——应用在跑会提示重试/取消）。
  ; 相对路径以本脚本所在目录（scripts/）为基准；.tmp-release/ 是 build.js 的暂存区
  File /r "..\.tmp-release\desk-pet-win-x64\*.*"

  ; 卸载器 + 应用和功能（Arp）注册：仅 HKCU
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Yuki"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_NAME}.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; 快捷方式：开始菜单 + 桌面
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
SectionEnd

Section "Uninstall"
  ; 自启登录项：先读值核对指向本安装目录才删——安装版与绿色版条目同名，
  ; 卸载安装版不能动绿色版的条目（误删了也会被绿色版下次启动的对账自愈）。
  ; StartupApproved\Run 伴生值不清理：不可见且无害（见 PACKAGING_PLAN 核对表）。
  ReadRegStr $0 HKCU "${RUN_KEY}" "${PRODUCT_NAME}"
  ${UnStrStr} $1 "$0" "$INSTDIR"
  ${If} $1 != ""
    DeleteRegValue HKCU "${RUN_KEY}" "${PRODUCT_NAME}"
  ${EndIf}

  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
