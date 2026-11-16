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
// It also receives Android "Share" intents (src/app/android-share.ts) and, unless
// BASALT_ANDROID_STORE=1, installs signed updates from the GitHub release.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "src-tauri/gen/android";
// Store builds (Google Play) must not ask for REQUEST_INSTALL_PACKAGES; they
// update through the store and get no in-app installer.
const SELF_UPDATE = process.env.BASALT_ANDROID_STORE !== "1";
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

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

// ${MARKER} after \`tauri android init\`.
//
// Insets: edge-to-edge puts the WebView under the system bars and the
// keyboard, but older WebViews report neither as CSS safe areas. The insets
// (in CSS px) are readable through the \`BasaltAndroid\` bridge at start-up and
// pushed as a \`basalt-insets\` window event whenever they change. The page also
// reports its theme so the bar icons stay readable on its background.
//
// Sharing: text, links, images and PDFs shared to Basalt are read here
// (content URIs only, size-capped) and handed to the page as JSON through
// \`takeShare()\` after a \`basalt-share\` window event (src/app/android-share.ts).
//
// Updates${SELF_UPDATE ? "" : " (left out of this build)"}: \`installUpdate(url, version)\`
// downloads the APK from Basalt's GitHub releases, checks that it is this app in
// exactly that version and signed with the installed app's certificate, and
// hands it to the system installer, which asks the user to confirm. Progress
// and results arrive as \`basalt-update\` window events.
class MainActivity : TauriActivity() {
  @Volatile private var insetsJson = "{}"
  @Volatile private var pendingShare: String? = null
  @Volatile private var updating = false
  private var webView: WebView? = null
  private var installReceiver: BroadcastReceiver? = null
  private val installToken = java.util.UUID.randomUUID().toString()

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
    // A share that started the app; recreating the activity must not repeat it.
    if (savedInstanceState == null) receiveShare(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receiveShare(intent)
  }

  override fun onDestroy() {
    installReceiver?.let { unregisterReceiver(it) }
    installReceiver = null
    super.onDestroy()
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

        /** The last shared content as JSON, once; null when there is none. */
        @JavascriptInterface fun takeShare(): String? {
          val share = pendingShare
          pendingShare = null
          return share
        }
${SELF_UPDATE ? `
        @JavascriptInterface fun installUpdate(url: String, version: String): Boolean =
          startUpdate(url, version)
` : ""}      },
      "BasaltAndroid",
    )
    // Insets may have been applied before the page existed; send them again.
    webView.post { ViewCompat.requestApplyInsets(window.decorView) }
  }

  private fun dispatch(name: String, detail: String) = runOnUiThread {
    webView?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('\$name',{detail:\$detail}))",
      null,
    )
  }

  // ── sharing ──────────────────────────────────────────────────────────────

  private fun receiveShare(intent: Intent?) {
    val action = intent?.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    // Stream permissions belong to this intent; read before it goes away.
    Thread {
      val share =
        try {
          readShare(intent)
        } catch (error: Exception) {
          JSONObject().put("error", error.message ?: error.toString())
        }
      pendingShare = share.toString()
      dispatch("basalt-share", "null")
    }.start()
  }

  private fun readShare(intent: Intent): JSONObject {
    val share = JSONObject()
    intent.getStringExtra(Intent.EXTRA_SUBJECT)?.let { share.put("subject", it) }
    intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let { share.put("text", it.toString()) }
    val uris = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val list =
        if (Build.VERSION.SDK_INT >= 33)
          intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      list?.let { uris.addAll(it) }
    } else {
      val uri =
        if (Build.VERSION.SDK_INT >= 33)
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      uri?.let { uris.add(it) }
    }
    val files = JSONArray()
    val skipped = JSONArray()
    var total = 0L
    for ((index, uri) in uris.withIndex()) {
      // Only other apps' content URIs: a file:// URI or one of Basalt's own
      // providers could hand app-private files to the vault.
      val name = displayName(uri) ?: "Datei \${index + 1}"
      if (
        index >= MAX_SHARED_FILES ||
        uri.scheme != "content" ||
        uri.authority?.startsWith(packageName) != false
      ) {
        skipped.put(name)
        continue
      }
      val bytes = readLimited(uri, MAX_SHARED_BYTES - total)
      if (bytes == null) {
        skipped.put(name)
        continue
      }
      total += bytes.size
      files.put(
        JSONObject()
          .put("name", name)
          .put("type", contentResolver.getType(uri) ?: intent.type ?: "")
          .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
      )
    }
    return share.put("files", files).put("skipped", skipped)
  }

  private fun displayName(uri: Uri): String? =
    try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst() && !it.isNull(0)) it.getString(0) else null
      }
    } catch (_: Exception) {
      null
    }

  /** The whole stream, or null when it is unreadable or longer than \`limit\`. */
  private fun readLimited(uri: Uri, limit: Long): ByteArray? {
    if (limit <= 0) return null
    return try {
      contentResolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (out.size() + read > limit) return null
          out.write(buffer, 0, read)
        }
        out.toByteArray()
      }
    } catch (_: Exception) {
      null
    }
  }
${SELF_UPDATE ? `
  // ── updates ──────────────────────────────────────────────────────────────

  private fun startUpdate(url: String, version: String): Boolean {
    if (!url.startsWith(UPDATE_PREFIX) || !url.endsWith(".apk")) return false
    if (!Regex("^\\\\d+\\\\.\\\\d+\\\\.\\\\d+$").matches(version)) return false
    synchronized(this) {
      if (updating) return false
      updating = true
    }
    Thread {
      try {
        val apk = download(url)
        verify(apk, version)
        updateEvent("signature-checked")
        install(apk)
      } catch (error: Exception) {
        updating = false
        updateEvent("error", error.message ?: error.toString())
      }
    }.start()
    return true
  }

  private fun updateEvent(state: String, message: String? = null, done: Long = 0, total: Long = 0) {
    val detail = JSONObject().put("state", state)
    if (message != null) detail.put("message", message)
    if (state == "progress") detail.put("downloaded", done).put("total", total)
    dispatch("basalt-update", detail.toString())
  }

  private fun download(url: String): File {
    val dir = File(cacheDir, "updates")
    dir.deleteRecursively()
    dir.mkdirs()
    val file = File(dir, "basalt-update.apk")
    // Redirects to GitHub's download host are followed (HTTPS only).
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    connection.setRequestProperty("User-Agent", "Basalt")
    try {
      if (connection.responseCode != 200)
        throw IllegalStateException("HTTP \${connection.responseCode}")
      if (connection.url.protocol != "https") throw IllegalStateException("Insecure redirect")
      val total = connection.contentLengthLong
      if (total > MAX_APK_BYTES) throw IllegalStateException("APK too large")
      connection.inputStream.use { input ->
        file.outputStream().use { output ->
          val buffer = ByteArray(256 * 1024)
          var done = 0L
          var reported = 0L
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            done += read
            if (done > MAX_APK_BYTES) throw IllegalStateException("APK too large")
            output.write(buffer, 0, read)
            val now = System.currentTimeMillis()
            if (now - reported > 250) {
              reported = now
              updateEvent("progress", null, done, total)
            }
          }
          updateEvent("progress", null, done, total)
        }
      }
    } finally {
      connection.disconnect()
    }
    return file
  }

  /** Same app, exactly the announced version, signed with the installed certificate. */
  private fun verify(apk: File, version: String) {
    val flags =
      if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
      else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
    val archive =
      packageManager.getPackageArchiveInfo(apk.path, flags)
        ?: throw IllegalStateException("The download is not an Android package")
    if (archive.packageName != packageName)
      throw IllegalStateException("The package is not Basalt")
    if (archive.versionName != version)
      throw IllegalStateException("The package has version \${archive.versionName}, not \$version")
    val installed = certificates(packageManager.getPackageInfo(packageName, flags))
    val offered = certificates(archive)
    if (installed.isEmpty() || offered.isEmpty() || offered.none { it in installed })
      throw IllegalStateException("SIGNATURE_MISMATCH")
  }

  private fun certificates(info: PackageInfo): Set<String> {
    val signatures =
      if (Build.VERSION.SDK_INT >= 28) {
        val signing = info.signingInfo ?: return emptySet()
        if (signing.hasMultipleSigners()) signing.apkContentsSigners
        else signing.signingCertificateHistory
      } else @Suppress("DEPRECATION") info.signatures
    val digest = MessageDigest.getInstance("SHA-256")
    return signatures.orEmpty()
      .map { signature -> digest.digest(signature.toByteArray()).joinToString("") { "%02x".format(it) } }
      .toSet()
  }

  private fun install(apk: File) {
    val installer = packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(packageName)
    params.setSize(apk.length())
    registerInstallReceiver()
    val id = installer.createSession(params)
    installer.openSession(id).use { session ->
      apk.inputStream().use { input ->
        session.openWrite("basalt.apk", 0, apk.length()).use { output ->
          input.copyTo(output)
          session.fsync(output)
        }
      }
      // Explicit, package-bound broadcast to a receiver no other app can reach.
      val status =
        Intent(INSTALL_STATUS).setPackage(packageName).putExtra(INSTALL_TOKEN, installToken)
      val flags =
        PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
      session.commit(PendingIntent.getBroadcast(this, id, status, flags).intentSender)
    }
    apk.delete()
  }

  @Synchronized private fun registerInstallReceiver() {
    if (installReceiver != null) return
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
          // Before Android 13 the receiver cannot be private; only our own
          // PendingIntent knows this per-process token.
          if (intent.getStringExtra(INSTALL_TOKEN) != installToken) return
          when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
              val confirm =
                if (Build.VERSION.SDK_INT >= 33)
                  intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else @Suppress("DEPRECATION") intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
              if (confirm == null) {
                updating = false
                updateEvent("error", "No confirmation from the system installer")
              } else {
                updateEvent("confirm")
                startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
              }
            }
            PackageInstaller.STATUS_SUCCESS -> {
              updating = false
              updateEvent("installed")
            }
            else -> {
              updating = false
              updateEvent(
                if (status == PackageInstaller.STATUS_FAILURE_ABORTED) "cancelled" else "error",
                intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Status \$status",
              )
            }
          }
        }
      }
    if (Build.VERSION.SDK_INT >= 33)
      registerReceiver(receiver, IntentFilter(INSTALL_STATUS), Context.RECEIVER_NOT_EXPORTED)
    else registerReceiver(receiver, IntentFilter(INSTALL_STATUS))
    installReceiver = receiver
  }
` : ""}
  companion object {
    private const val MAX_SHARED_FILES = 20
    private const val MAX_SHARED_BYTES = 32L * 1024 * 1024
${SELF_UPDATE ? `    private const val MAX_APK_BYTES = 256L * 1024 * 1024
    private const val UPDATE_PREFIX = "https://github.com/Nino4you/basalt/releases/download/"
    private const val INSTALL_STATUS = "io.github.nino4you.basalt.INSTALL_STATUS"
    private const val INSTALL_TOKEN = "io.github.nino4you.basalt.INSTALL_TOKEN"
` : ""}  }
}
`,
);

// Older Android versions only deliver keyboard insets with adjustResize.
const manifestPath = join(root, "app/src/main/AndroidManifest.xml");
let manifest = readFileSync(manifestPath, "utf8");
const activityTag = /<activity\b[^>]*>/;
if (!activityTag.test(manifest)) throw new Error(`No <activity> in ${manifestPath}`);
if (!manifest.includes("android:windowSoftInputMode"))
  manifest = manifest.replace(
    /<activity\b/,
    '<activity\n            android:windowSoftInputMode="adjustResize"',
  );
// One activity instance, so a share while Basalt runs arrives in onNewIntent.
if (!/<activity\b[^>]*android:launchMode=/.test(manifest))
  manifest = manifest.replace(
    /<activity\b/,
    '<activity\n            android:launchMode="singleTask"',
  );
const SHARE_MARKER = "<!-- Basalt: share targets -->";
if (!manifest.includes(SHARE_MARKER)) {
  const closing = manifest.indexOf("</activity>");
  if (closing < 0) throw new Error(`No </activity> in ${manifestPath}`);
  const filters = `${SHARE_MARKER}
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/*" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/pdf" />
            </intent-filter>
        `;
  manifest = manifest.slice(0, closing) + filters + manifest.slice(closing);
}
const INSTALL_PERMISSION =
  '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />';
if (SELF_UPDATE && !manifest.includes("REQUEST_INSTALL_PACKAGES"))
  manifest = manifest.replace(/<application\b/, `${INSTALL_PERMISSION}\n    <application`);
if (!SELF_UPDATE) manifest = manifest.replace(`${INSTALL_PERMISSION}\n    `, "");
writeFileSync(manifestPath, manifest);

console.log(`Patched ${activityPath} and ${manifestPath}`);
