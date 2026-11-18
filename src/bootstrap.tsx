import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import './app/theme.css'
import './app/global.css'

// KaTeX, Mermaid and syntax highlighters stay lazy until a message actually needs them.
setupTheme()
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
