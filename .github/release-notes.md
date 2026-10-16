Preview build. Pick the file for your computer:

| Computer | Download |
| --- | --- |
| Windows 10/11 | `Blog-Editor-Setup-<version>.exe` |
| Mac with Apple silicon (M1 and later) | `Blog-Editor-<version>-mac-arm64.dmg` |
| Intel Mac | `Blog-Editor-<version>-mac-x64.dmg` |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple silicon.

### Windows
Run the installer. It is not code-signed, so SmartScreen says **"Windows protected your PC"**: click **More info → Run anyway**. Windows updates itself to later releases automatically.

### Mac
1. Open the `.dmg` and drag **Blog Editor** into **Applications**.
2. Open it. macOS says it **cannot verify the developer** — click **Done** (not Move to Trash).
3. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to "Blog Editor was blocked", then confirm.

This is needed once. The app is not notarized by Apple, which is what the warning is about. Mac does not update itself yet: install new releases the same way.

### First run
The app opens on **Set up a blog**, which walks through connecting a Cloudflare account (about ten minutes, best done with whoever is helping).
