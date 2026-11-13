// Applies Basalt's changes to the Android project that `tauri android init`
// generates into src-tauri/gen/android (not checked in). Run it after every
// init; it is idempotent:
//
//   npm run tauri -- android init --ci --skip-targets-install
//   node tools/patch_android.mjs
//
// Why: Tauri's MainActivity draws edge-to-edge, under the status bar, the
// navigation bar and the on-screen keyboard. Android WebViews before Chrome
// 136 report none of these as CSS safe areas, so the app's bottom bar ended
// up under the system navigation and the keyboard covered the editor. The
// patched activity forwards the insets to the page (src/ui/android-insets.ts).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "src-tauri/gen/android";
const MARKER = "Patched by tools/patch_android.mjs";

function find(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = find(path, name);
      if (found) return found;
    } else if (entry.name === name) return path;
  }
  return null;
}

const activityPath = find(join(root, "app/src/main/java"), "MainActivity.kt");
if (!activityPath) throw new Error(`MainActivity.kt not found under ${root}`);
const current = readFileSync(activityPath, "utf8");
const pkg = /^package\s+([\w.]+)/m.exec(current)?.[1];
if (!pkg) throw new Error(`No package declaration in ${activityPath}`);

writeFileSync(
  activityPath,
  `package ${pkg}

import android.graphics.Color
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// ${MARKER} after \`tauri android init\`.
// Edge-to-edge puts the WebView under the system bars and the keyboard, but
// older WebViews report neither as CSS safe areas. The insets (in CSS px) are
// readable through the \`BasaltAndroid\` bridge at start-up and pushed as a
// \`basalt-insets\` window event whenever they change. The page also reports
// its theme so the bar icons stay readable on its background.
class MainActivity : TauriActivity() {
  @Volatile private var insetsJson = "{}"
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { view, insets ->
      val density = resources.displayMetrics.density
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      fun css(px: Int) = px / density
      insetsJson = "{\\"top\\":\${css(bars.top)},\\"right\\":\${css(bars.right)}," +
        "\\"bottom\\":\${css(bars.bottom)},\\"left\\":\${css(bars.left)}," +
        "\\"ime\\":\${css(ime.bottom)}}"
      webView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('basalt-insets',{detail:\$insetsJson}))",
        null,
      )
      ViewCompat.onApplyWindowInsets(view, insets)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(
      object {
        @JavascriptInterface fun insets(): String = insetsJson

        @JavascriptInterface fun setDarkBars(dark: Boolean) = runOnUiThread {
          // Transparent bars show the app's own background behind them.
          val style =
            if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
            else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
          enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
        }
      },
      "BasaltAndroid",
    )
    // Insets may have been applied before the page existed; send them again.
    webView.post { ViewCompat.requestApplyInsets(window.decorView) }
  }
}
`,
);

// Older Android versions only deliver keyboard insets with adjustResize.
const manifestPath = join(root, "app/src/main/AndroidManifest.xml");
const manifest = readFileSync(manifestPath, "utf8");
if (!manifest.includes("android:windowSoftInputMode")) {
  const patched = manifest.replace(
    /<activity\b/,
    '<activity\n            android:windowSoftInputMode="adjustResize"',
  );
  if (patched === manifest) throw new Error(`No <activity> in ${manifestPath}`);
  writeFileSync(manifestPath, patched);
}

console.log(`Patched ${activityPath} and ${manifestPath}`);
