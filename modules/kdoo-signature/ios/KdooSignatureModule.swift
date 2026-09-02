import ExpoModulesCore

public class KdooSignatureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KdooSignature")

    Function("getSha1") { () -> String in
      return "N/A (iOS - no SHA1 signature available)"
    }
  }
}