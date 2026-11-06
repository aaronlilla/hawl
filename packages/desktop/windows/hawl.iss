; Hawl desktop installer for Windows (Inno Setup 6). Per-user, no admin prompt.
; Installs the hawl CLI to %USERPROFILE%\.hawl\bin (the same place install.ps1 and `hawl update`
; use), puts it on the user PATH, turns on the helper's login autostart (`hawl autostart on`,
; a per-user Task Scheduler task) and starts the tray app at login.
; Built by build.ps1. Pass a site to pre-fill the join step: hawl-setup-win-x64.exe /SITE=acme
; Unsigned: SmartScreen shows "Windows protected your PC" until we sign it (see ../README.md).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef BuildDir
  #define BuildDir "out"
#endif

[Setup]
AppId={{6F0B8E2C-4C1A-4F0B-9E57-2B3C9A7D1E44}
AppName=Hawl
AppVersion={#AppVersion}
AppVerName=Hawl {#AppVersion}
AppPublisher=Hawl
AppPublisherURL=https://hawl.ai
AppSupportURL=https://hawl.ai/docs
DefaultDirName={localappdata}\Programs\Hawl
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=hawl-setup-win-x64
SetupIconFile=..\assets\hawl.ico
UninstallDisplayIcon={app}\HawlTray.exe
UninstallDisplayName=Hawl
ChangesEnvironment=yes
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no

[Files]
Source: "{#BuildDir}\hawl.exe"; DestDir: "{%USERPROFILE}\.hawl\bin"; Flags: ignoreversion
Source: "{#BuildDir}\HawlTray.exe"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "HawlTray"; ValueData: """{app}\HawlTray.exe"""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{%USERPROFILE}\.hawl\bin"; Check: NeedsAddPath(ExpandConstant('{%USERPROFILE}\.hawl\bin'))

[Icons]
Name: "{userprograms}\Hawl"; Filename: "{app}\HawlTray.exe"

[Run]
Filename: "{%USERPROFILE}\.hawl\bin\hawl.exe"; Parameters: "autostart on"; WorkingDir: "{%USERPROFILE}"; Flags: runhidden waituntilterminated; StatusMsg: "Starting the hawl helper..."
Filename: "{app}\HawlTray.exe"; Flags: nowait postinstall runasoriginaluser; Description: "Show Hawl in the system tray"
Filename: "{app}\HawlTray.exe"; Parameters: "--connect --site ""{code:SiteParam}"""; Flags: nowait postinstall skipifsilent runasoriginaluser; Description: "Connect a project folder now (opens hawl join)"

[UninstallRun]
Filename: "taskkill.exe"; Parameters: "/IM HawlTray.exe /F"; Flags: runhidden; RunOnceId: "KillTray"
Filename: "{%USERPROFILE}\.hawl\bin\hawl.exe"; Parameters: "daemon stop"; Flags: runhidden; RunOnceId: "StopHelper"
Filename: "{%USERPROFILE}\.hawl\bin\hawl.exe"; Parameters: "autostart off"; Flags: runhidden; RunOnceId: "AutostartOff"

[UninstallDelete]
Type: files; Name: "{%USERPROFILE}\.hawl\bin\hawl.exe.old"
Type: files; Name: "{%USERPROFILE}\.hawl\bin\hawl.exe.next"

[Code]
const
  EnvKey = 'Environment';

function SiteParam(Param: String): String;
begin
  Result := ExpandConstant('{param:SITE|}');
end;

function NeedsAddPath(Dir: String): Boolean;
var
  Cur: String;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Cur) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Cur) + ';') = 0;
end;

// An update over a running install: the helper and tray hold hawl.exe and HawlTray.exe open.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  RC: Integer;
  Hawl: String;
begin
  Hawl := ExpandConstant('{%USERPROFILE}\.hawl\bin\hawl.exe');
  Exec('taskkill.exe', '/IM HawlTray.exe /F', '', SW_HIDE, ewWaitUntilTerminated, RC);
  if FileExists(Hawl) then
  begin
    Exec(Hawl, 'daemon stop', '', SW_HIDE, ewWaitUntilTerminated, RC);
    Sleep(1500);
  end;
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Cur, Dir: String;
  P: Integer;
begin
  if CurUninstallStep <> usPostUninstall then exit;
  Dir := ExpandConstant('{%USERPROFILE}\.hawl\bin');
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Cur) then exit;
  P := Pos(';' + Uppercase(Dir), Uppercase(Cur));
  if P > 0 then
  begin
    Delete(Cur, P, Length(Dir) + 1);
    RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Cur);
  end;
end;
