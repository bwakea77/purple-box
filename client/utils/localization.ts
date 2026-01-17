// Safe wrapper for expo-localization
// Returns null if the module is not available (requires app rebuild)

let localizationModule: any = null;
let moduleChecked = false;

function getLocalizationModule() {
  if (moduleChecked) {
    return localizationModule;
  }
  
  moduleChecked = true;
  try {
    localizationModule = require('expo-localization');
    return localizationModule;
  } catch (error) {
    // Module not available - app needs rebuild
    localizationModule = null;
    return null;
  }
}

// Synchronous version that returns null if module not available
export function getDeviceRegionCodeSync(): string | null {
  try {
    const Localization = getLocalizationModule();
    if (!Localization) {
      return null;
    }
    
    const locales = Localization.getLocales();
    const topLocale = locales[0];
    return topLocale?.regionCode || null;
  } catch (error) {
    // Module not available or error accessing it
    return null;
  }
}