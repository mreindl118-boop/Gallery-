import { useEffect, useRef, useState } from 'react'
import type { GeneratorProvider, KeyedProvider } from '@shared/build'
import { loadGenerator, updateGenerator } from '../lib/bridge'
import { PROVIDER_NAMES } from '../lib/format'
import { reportError, useApp } from '../state/store'
import { Button } from './Button'
import { Segmented } from './Segmented'

const PROVIDERS: Array<{ value: GeneratorProvider; label: string }> = (
  ['none', 'stability', 'openai', 'xai'] as const
).map((value) => ({ value, label: PROVIDER_NAMES[value] }))

/** Settings → Generator: which image provider makes assets, its key, and the limits every build keeps to. */
export function GeneratorSection() {
  const g = useApp((s) => s.generator)
  const notify = useApp((s) => s.notify)
  const [key, setKey] = useState('')
  const [checking, setChecking] = useState(false)
  const imagesField = useRef<HTMLInputElement>(null)
  const capField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!g) void loadGenerator()
  }, [g])

  if (!g) return null
  const provider = g.provider
  const keyed: KeyedProvider | null = provider === 'none' ? null : provider
  const hasKey = keyed ? g.hasKey[keyed] : false

  const saveKey = async () => {
    if (!keyed || !key.trim()) return
    if (await updateGenerator(window.gallery.invoke('generator.setKey', { provider: keyed, key: key.trim() }))) {
      setKey('')
    }
  }

  const checkKey = async () => {
    if (!keyed) return
    setChecking(true)
    try {
      const r = await window.gallery.invoke('generator.test', { provider: keyed })
      notify(r.message, r.ok ? 'info' : 'error', { key: 'generator-check' })
    } catch (err) {
      reportError(err)
    } finally {
      setChecking(false)
    }
  }

  // The limit fields are uncontrolled and keyed by the saved values, so a save (or a failed one) shows what main kept.
  const saveLimits = () => {
    const imagesPerBuild = Math.round(Number(imagesField.current?.value))
    const spendCapUsd = Number(capField.current?.value)
    if (!Number.isFinite(imagesPerBuild) || !Number.isFinite(spendCapUsd)) return
    if (imagesPerBuild < 0 || imagesPerBuild > 200 || spendCapUsd < 0 || spendCapUsd > 1000) return
    if (imagesPerBuild === g.imagesPerBuild && spendCapUsd === g.spendCapUsd) return
    void updateGenerator(window.gallery.invoke('generator.setLimits', { imagesPerBuild, spendCapUsd }))
  }

  return (
    <>
      <Segmented
        value={provider}
        options={PROVIDERS}
        labelledBy="set-generator"
        onChange={(p) => void updateGenerator(window.gallery.invoke('generator.setProvider', { provider: p }))}
      />
      {keyed ? (
        <div className="generator-key">
          {hasKey ? (
            <div className="settings-row generator-saved">
              <span>A key is saved.</span>
              <Button onClick={() => updateGenerator(window.gallery.invoke('generator.clearKey', { provider: keyed }))}>
                Remove
              </Button>
              <Button disabled={checking} onClick={checkKey}>
                Check key
              </Button>
            </div>
          ) : (
            <form
              className="settings-row generator-key-form"
              onSubmit={(e) => {
                e.preventDefault()
                void saveKey()
              }}
            >
              <input
                className="field"
                type="password"
                autoComplete="off"
                aria-label={`${PROVIDER_NAMES[keyed]} key`}
                placeholder="Paste the key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={!key.trim()}>
                Save key
              </Button>
            </form>
          )}
        </div>
      ) : (
        <p className="settings-note">No assets are made; the gallery is built from your photos alone.</p>
      )}
      <div className="generator-limits">
        <label className="generator-limit">
          <span>Images per build</span>
          <input
            className="field"
            type="number"
            min={0}
            max={200}
            step={1}
            key={g.imagesPerBuild}
            ref={imagesField}
            defaultValue={g.imagesPerBuild}
            onBlur={saveLimits}
          />
        </label>
        <label className="generator-limit">
          <span>Spend cap</span>
          <span className="generator-money">
            <span className="generator-currency" aria-hidden="true">
              $
            </span>
            <input
              className="field"
              type="number"
              min={0}
              max={1000}
              step={0.5}
              aria-label="Spend cap in US dollars"
              key={g.spendCapUsd}
              ref={capField}
              defaultValue={g.spendCapUsd}
              onBlur={saveLimits}
            />
          </span>
        </label>
      </div>
      <p className="settings-note">Keys are stored encrypted on this PC and never written into a project.</p>
      <p className="settings-note settings-note-flush">
        Prices are read from generator-prices.json in galleryLAB’s settings folder.
      </p>
    </>
  )
}
