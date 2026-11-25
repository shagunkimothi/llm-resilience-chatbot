export const BUILT_IN_PROMPTS = [
  { id: 'concise', name: 'Concise assistant', text: 'You are a concise assistant. Answer in as few words as possible.' },
  { id: 'eli5', name: "Explain like I'm 5", text: 'Explain everything as if to a five-year-old, using simple words and short sentences.' },
  { id: 'french', name: 'Answer in French', text: 'Always answer in French, whatever language the question is in.' },
  {
    id: 'reviewer',
    name: 'Code reviewer',
    text: 'You are a careful code reviewer. Point out bugs, risks and unclear code, and suggest concrete fixes.',
  },
]

const KEY = 'resilix.savedPrompts'

export function loadSavedPrompts() {
  try {
    const raw = window.localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string' && typeof p.text === 'string') : []
  } catch {
    return []
  }
}

export function storeSavedPrompts(list) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}
