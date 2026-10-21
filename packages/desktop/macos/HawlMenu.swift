// Hawl menu bar app for macOS. On launch it installs the bundled `hawl` to ~/.hawl/bin,
// turns on the helper's login autostart (`hawl autostart on`, a LaunchAgent), registers
// itself as a login item, then shows the helper's status with start, stop and update.
// Built by build.sh with swiftc; no Xcode project.
import AppKit
import ServiceManagement

let home = FileManager.default.homeDirectoryForCurrentUser.path
let stateDir = ProcessInfo.processInfo.environment["HAWL_HOME"] ?? "\(home)/.hawl"
let hawlBin = "\(home)/.hawl/bin/hawl"
let launchLabel = "com.hawl.daemon"
let siteRe = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")

@discardableResult
func run(_ exe: String, _ args: [String], timeout: TimeInterval = 20) -> (Int32, String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: exe)
  p.arguments = args
  p.currentDirectoryURL = URL(fileURLWithPath: home)
  let out = Pipe()
  p.standardOutput = out
  p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return (127, "") }
  let deadline = Date().addingTimeInterval(timeout)
  while p.isRunning && Date() < deadline { usleep(50_000) }
  if p.isRunning { p.terminate() }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

/// Opens Terminal running `command` so the user sees prompts and output (join, update).
func inTerminal(_ command: String) {
  let esc = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  _ = run("/usr/bin/osascript", ["-e", "tell application \"Terminal\" to activate", "-e", "tell application \"Terminal\" to do script \"\(esc)\""])
}

final class App: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  let statusLine = NSMenuItem(title: "Checking the hawl helper…", action: nil, keyEquivalent: "")
  var startItem: NSMenuItem!
  var stopItem: NSMenuItem!
  var polling = false

  func applicationDidFinishLaunching(_ n: Notification) {
    installCli()
    if #available(macOS 13.0, *) { try? SMAppService.mainApp.register() }

    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let img = Bundle.main.image(forResource: "menubar") {
      img.isTemplate = true
      img.size = NSSize(width: 18, height: 18)
      item.button?.image = img
    } else {
      item.button?.title = "hawl"
    }
    let menu = NSMenu()
    menu.autoenablesItems = false
    statusLine.isEnabled = false
    menu.addItem(statusLine)
    menu.addItem(.separator())
    startItem = add(menu, "Start helper", #selector(start))
    stopItem = add(menu, "Stop helper", #selector(stop))
    add(menu, "Restart helper", #selector(restart))
    menu.addItem(.separator())
    add(menu, "Connect a project folder…", #selector(connect))
    add(menu, "Check for updates…", #selector(update))
    add(menu, "Open hawl.ai", #selector(openSite))
    add(menu, "Open logs folder", #selector(openLogs))
    menu.addItem(.separator())
    add(menu, "Quit (helper keeps running)", #selector(quit))
    item.menu = menu

    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.poll() }
    poll()
  }

  @discardableResult
  func add(_ menu: NSMenu, _ title: String, _ sel: Selector) -> NSMenuItem {
    let m = NSMenuItem(title: title, action: sel, keyEquivalent: "")
    m.target = self
    menu.addItem(m)
    return m
  }

  /// Copies the bundled CLI over ~/.hawl/bin/hawl when it differs, then turns on autostart.
  func installCli() {
    guard let bundled = Bundle.main.path(forResource: "hawl", ofType: nil) else { return }
    let fm = FileManager.default
    try? fm.createDirectory(atPath: "\(home)/.hawl/bin", withIntermediateDirectories: true)
    let same = fm.contentsEqual(atPath: bundled, andPath: hawlBin)
    if !same {
      if fm.fileExists(atPath: hawlBin) { _ = run(hawlBin, ["daemon", "stop"], timeout: 8) }
      let tmp = hawlBin + ".installing"
      try? fm.removeItem(atPath: tmp)
      do {
        try fm.copyItem(atPath: bundled, toPath: tmp)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tmp)
        _ = try fm.replaceItemAt(URL(fileURLWithPath: hawlBin), withItemAt: URL(fileURLWithPath: tmp))
      } catch {
        try? fm.moveItem(atPath: tmp, toPath: hawlBin)
      }
      // Files copied out of a downloaded app keep the quarantine flag; the helper runs headless.
      _ = run("/usr/bin/xattr", ["-d", "com.apple.quarantine", hawlBin], timeout: 5)
    }
    _ = run(hawlBin, ["autostart", "on"], timeout: 30)
  }

  func poll() {
    if polling { return }
    polling = true
    DispatchQueue.global().async {
      var text = "Helper stopped"
      var running = false
      if !FileManager.default.fileExists(atPath: hawlBin) {
        text = "hawl is not installed. Reopen Hawl."
      } else {
        let (_, out) = run(hawlBin, ["status", "--json"], timeout: 8)
        if let d = out.data(using: .utf8),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let dm = j["daemon"] as? [String: Any], dm["running"] as? Bool == true
        {
          running = true
          let ver = dm["version"] as? String ?? ""
          let workers = dm["workers"] as? Int ?? 0
          let conn = dm["connected"] as? Int ?? 0
          text = "Helper running" + (ver.isEmpty ? "" : " (v\(ver))")
          text += workers == 0 ? ", no folders connected" : ", \(conn) of \(workers) agents online"
        }
      }
      DispatchQueue.main.async {
        self.polling = false
        self.statusLine.title = text
        self.startItem.isEnabled = !running
        self.stopItem.isEnabled = running
        self.item.button?.toolTip = "Hawl: \(text)"
      }
    }
  }

  @objc func start() {
    let uid = getuid()
    if run("/bin/launchctl", ["kickstart", "gui/\(uid)/\(launchLabel)"]).0 != 0 {
      run(hawlBin, ["daemon", "start"])
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.poll() }
  }

  @objc func stop() {
    run(hawlBin, ["daemon", "stop"], timeout: 8)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.poll() }
  }

  @objc func restart() {
    stop()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.start() }
  }

  @objc func connect() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.message = "Pick the project folder your agent works in (Claude Code, Codex, Cursor…)."
    panel.prompt = "Choose"
    NSApp.activate(ignoringOtherApps: true)
    guard panel.runModal() == .OK, let folder = panel.url?.path else { return }

    let alert = NSAlert()
    alert.messageText = "Connect to Hawl"
    alert.informativeText = "Your site's address or name (for example hawl.ai/t/acme or acme):"
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
    alert.accessoryView = field
    alert.addButton(withTitle: "Connect")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let site = field.stringValue.trimmingCharacters(in: .whitespaces)
    let range = NSRange(site.startIndex..., in: site)
    guard siteRe.firstMatch(in: site, range: range) != nil else {
      let bad = NSAlert()
      bad.messageText = "That doesn't look like a site address. Copy it from your site's page on hawl.ai."
      bad.runModal()
      return
    }
    inTerminal("cd \(shellQuote(folder)) && \(shellQuote(hawlBin)) join \(shellQuote(site))")
  }

  @objc func update() {
    let h = shellQuote(hawlBin)
    inTerminal("\(h) update && \(h) update --now && \(h) daemon stop; sleep 2; launchctl kickstart gui/$(id -u)/\(launchLabel); echo Done.")
  }

  @objc func openSite() { NSWorkspace.shared.open(URL(string: "https://hawl.ai")!) }

  @objc func openLogs() {
    let logs = "\(stateDir)/logs"
    let dir = FileManager.default.fileExists(atPath: logs) ? logs : stateDir
    NSWorkspace.shared.open(URL(fileURLWithPath: dir))
  }

  @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
