/** A single Android back action dismisses only the highest-priority UI layer. */
const handlers: { callback: () => boolean; priority: number }[] = []

export const registerBackHandler = (callback: () => boolean, priority = 0) => {
  const entry = { callback, priority }
  handlers.push(entry)
  return () => {
    const index = handlers.indexOf(entry)
    if (index >= 0) {
      handlers.splice(index, 1)
    }
  }
}

export const handleAndroidBack = (): boolean => {
  const sorted = handlers.map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.priority - a.priority || b.index - a.index)
  return sorted.some(({ callback }) => callback())
}
