// electron-builder afterPack hook: ad-hoc sign the macOS app before the dmg is built.
// electron-builder 25 does not treat identity "-" as ad-hoc, and left unsigned the
// bundle keeps Electron's original signature, broken by the packaging edits —
// which Gatekeeper reports on Apple Silicon as "damaged". See electron-builder.yml.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed  ${path.basename(app)}`)
}
