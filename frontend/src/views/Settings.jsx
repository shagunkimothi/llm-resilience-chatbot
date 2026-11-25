import { useState } from 'react'
import { API_URL } from '../api.js'
import { ViewHeader } from '../components.jsx'
import { BUILT_IN_PROMPTS } from '../lib/prompts.js'

export default function Settings({ savedPrompts, onSavePrompts, onUsePrompt, prices, setPrices, storageOk }) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')

  function save(e) {
    e.preventDefault()
    if (!name.trim() || !text.trim()) return
    onSavePrompts([...savedPrompts, { id: `u-${Date.now()}`, name: name.trim(), text: text.trim() }])
    setName('')
    setText('')
  }

  const PromptRow = ({ p, removable }) => (
    <li key={p.id} className="prompt-row" data-testid={`prompt-${p.id}`}>
      <div>
        <span className="prompt-name">{p.name}</span>
        <span className="prompt-text">{p.text}</span>
      </div>
      <span className="prompt-actions">
        <button type="button" className="btn-ghost" onClick={() => onUsePrompt(p.text)} data-testid={`use-prompt-${p.id}`}>
          Use
        </button>
        {removable && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onSavePrompts(savedPrompts.filter((x) => x.id !== p.id))}
            aria-label={`Remove ${p.name}`}
          >
            Remove
          </button>
        )}
      </span>
    </li>
  )

  return (
    <div className="view" data-testid="view-settings">
      <ViewHeader title="Settings">Preferences for this browser. The failure simulation lives under Request settings in the Playground.</ViewHeader>

      <section className="card panel">
        <h2 className="panel-title">Prompt lab</h2>
        <p className="note">“Use” fills the Playground system prompt for your next message.</p>
        <ul className="prompt-list">
          {BUILT_IN_PROMPTS.map((p) => PromptRow({ p, removable: false }))}
          {savedPrompts.map((p) => PromptRow({ p, removable: true }))}
        </ul>
        <form className="prompt-form" onSubmit={save}>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My prompt" data-testid="prompt-name" />
          </label>
          <label className="field">
            <span>System prompt</span>
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} data-testid="prompt-text" />
          </label>
          <button type="submit" className="btn-primary" disabled={!name.trim() || !text.trim()} data-testid="prompt-save">
            Save prompt
          </button>
          {!storageOk && <p className="note warn">Browser storage is unavailable, so saved prompts last only for this visit.</p>}
        </form>
      </section>

      <section className="card panel">
        <h2 className="panel-title">Cost estimator</h2>
        <p className="note">Prices per 1M tokens, applied to live-inference tokens on the Overview. Cached replies cost nothing.</p>
        <div className="price-row">
          <label className="field">
            <span>Input price (USD / 1M tokens)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={prices.input}
              onChange={(e) => setPrices((p) => ({ ...p, input: e.target.value }))}
              data-testid="price-input"
            />
          </label>
          <label className="field">
            <span>Output price (USD / 1M tokens)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={prices.output}
              onChange={(e) => setPrices((p) => ({ ...p, output: e.target.value }))}
              data-testid="price-output"
            />
          </label>
        </div>
      </section>

      <section className="card panel">
        <h2 className="panel-title">API</h2>
        <label className="field">
          <span>API base URL (set at build time with VITE_API_URL)</span>
          <input value={API_URL} readOnly data-testid="api-url" />
        </label>
      </section>
    </div>
  )
}
