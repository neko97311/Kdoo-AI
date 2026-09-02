package expo.modules.kdoosignature

import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest

class KdooSignatureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KdooSignature")

    Function("getSha1") {
      try {
        val context = appContext.reactContext ?: return@Function "N/A"
        val packageName = context.packageName
        val pkgInfo = context.packageManager.getPackageInfo(
          packageName,
          PackageManager.GET_SIGNATURES
        )
        val sig = pkgInfo.signatures?.firstOrNull()?.toByteArray()
          ?: return@Function "N/A"
        val md = MessageDigest.getInstance("SHA1")
        val digest = md.digest(sig)
        digest.joinToString(":") { byte -> "%02X".format(byte) }
      } catch (e: Exception) {
        "Error: ${e.message}"
      }
    }
  }
}