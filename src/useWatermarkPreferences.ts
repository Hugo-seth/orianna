import { useEffect, useState, useSyncExternalStore } from 'react'
import { createWatermarkPreferencesStore } from './watermark-preferences'

export function useWatermarkPreferences() {
  const [store] = useState(() => createWatermarkPreferencesStore())
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  useEffect(() => {
    void store.load()
    const flush = () => store.flushPending()
    const flushOnHidden = () => { if (document.visibilityState === 'hidden') store.flushPending() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flushOnHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flushOnHidden)
      store.flushPending()
    }
  }, [store])

  return {
    ...snapshot,
    updateSettings: store.updateSettings,
    setAssetUploadsEnabled: store.setAssetUploadsEnabled,
    retrySave: store.retrySave,
    replacePreferences: store.replacePreferences,
  }
}
