import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import './App.css'

interface Preset {
  id: string
  name: string
  maxWidth: number | null
  maxHeight: number | null
  quality: number
  reducePercent: number
}

interface ConvertedImage {
  id: string
  originalName: string
  originalSize: number
  convertedSize: number
  blob: Blob
  previewUrl: string
  preset: Preset
}

interface QueuedImage {
  id: string
  file: File
  originalPath?: string
  previewUrl: string
  preset: Preset
  status: 'pending' | 'converting' | 'done' | 'error'
  converted?: ConvertedImage
  error?: string
}

const clamp = (value: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, value))
}

const normalizeDimension = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return Math.round(value)
}

const normalizePreset = (preset: Partial<Preset>): Preset => ({
  id: typeof preset.id === 'string' && preset.id.trim() ? preset.id : crypto.randomUUID(),
  name: typeof preset.name === 'string' ? preset.name : '',
  maxWidth: normalizeDimension(preset.maxWidth),
  maxHeight: normalizeDimension(preset.maxHeight),
  quality: clamp(
    typeof preset.quality === 'number' && Number.isFinite(preset.quality)
      ? Math.round(preset.quality)
      : 85,
    1,
    100
  ),
  reducePercent: clamp(
    typeof preset.reducePercent === 'number' && Number.isFinite(preset.reducePercent)
      ? Math.round(preset.reducePercent)
      : 0,
    0,
    95
  ),
})

const DEFAULT_PRESETS: Preset[] = [
  { id: 'original', name: 'ORIGINAL', maxWidth: null, maxHeight: null, quality: 90, reducePercent: 0 },
  { id: 'large', name: '1920px', maxWidth: 1920, maxHeight: 1920, quality: 85, reducePercent: 0 },
  { id: 'medium', name: '1280px', maxWidth: 1280, maxHeight: 1280, quality: 85, reducePercent: 0 },
  { id: 'small', name: '800px', maxWidth: 800, maxHeight: 800, quality: 80, reducePercent: 0 },
  { id: 'thumb', name: '400px', maxWidth: 400, maxHeight: 400, quality: 75, reducePercent: 0 },
]

const loadPresets = (): Preset[] => {
  const saved = localStorage.getItem('webp-presets')
  if (!saved) return DEFAULT_PRESETS

  try {
    const parsed = JSON.parse(saved)
    if (!Array.isArray(parsed)) {
      return DEFAULT_PRESETS
    }

    const normalizedPresets = parsed.map(preset => normalizePreset(preset as Partial<Preset>))
    return normalizedPresets.length > 0 ? normalizedPresets : DEFAULT_PRESETS
  } catch {
    return DEFAULT_PRESETS
  }
}

function App() {
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets())
  const [selectedPreset, setSelectedPreset] = useState<Preset>(presets[0])
  const [queue, setQueue] = useState<QueuedImage[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [showPresetEditor, setShowPresetEditor] = useState(false)
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<QueuedImage[]>([])
  const isProcessingRef = useRef(false)

  useEffect(() => {
    localStorage.setItem('webp-presets', JSON.stringify(presets))
  }, [presets])

  const convertToWebP = useCallback(async (file: File, preset: Preset): Promise<ConvertedImage> => {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')

      img.onload = () => {
        let { width, height } = img

        if (preset.reducePercent > 0) {
          const ratio = (100 - preset.reducePercent) / 100
          width = Math.max(1, Math.round(width * ratio))
          height = Math.max(1, Math.round(height * ratio))
        }

        if (preset.maxWidth || preset.maxHeight) {
          const maxW = preset.maxWidth || Infinity
          const maxH = preset.maxHeight || Infinity
          const ratio = Math.min(maxW / width, maxH / height)
          if (ratio < 1) {
            width = Math.round(width * ratio)
            height = Math.round(height * ratio)
          }
        }

        canvas.width = width
        canvas.height = height
        ctx?.drawImage(img, 0, 0, width, height)

        canvas.toBlob(
          (blob) => {
            if (blob) {
              const previewUrl = URL.createObjectURL(blob)
              resolve({
                id: crypto.randomUUID(),
                originalName: file.name,
                originalSize: file.size,
                convertedSize: blob.size,
                blob,
                previewUrl,
                preset,
              })
            } else {
              reject(new Error('Failed to create blob'))
            }
          },
          'image/webp',
          preset.quality / 100
        )
      }

      img.onerror = () => reject(new Error('Failed to load image'))
      img.src = URL.createObjectURL(file)
    })
  }, [])

  const processQueue = useCallback(async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true
    setIsProcessing(true)

    const processNext = async (): Promise<void> => {
      const nextImage = queueRef.current.find(image => image.status === 'pending')
      if (!nextImage) {
        isProcessingRef.current = false
        setIsProcessing(false)
        return
      }

      queueRef.current = queueRef.current.map(q =>
        q.id === nextImage.id ? { ...q, status: 'converting' as const } : q
      )
      setQueue([...queueRef.current])

      try {
        const converted = await convertToWebP(nextImage.file, nextImage.preset)
        queueRef.current = queueRef.current.map(q =>
          q.id === nextImage.id ? { ...q, status: 'done' as const, converted } : q
        )
        setQueue([...queueRef.current])
      } catch (err) {
        queueRef.current = queueRef.current.map(q =>
          q.id === nextImage.id ? { ...q, status: 'error' as const, error: (err as Error).message } : q
        )
        setQueue([...queueRef.current])
      }

      await processNext()
    }

    await processNext()
  }, [convertToWebP])

  const handleFiles = useCallback((files: FileList | File[], paths?: string[]) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    const newImages: QueuedImage[] = imageFiles.map((file, index) => ({
      id: crypto.randomUUID(),
      file,
      originalPath: paths?.[index],
      previewUrl: URL.createObjectURL(file),
      preset: selectedPreset,
      status: 'pending' as const,
    }))

    const nextQueue = [...queueRef.current, ...newImages]
    queueRef.current = nextQueue
    setQueue(nextQueue)
    processQueue()
  }, [selectedPreset, processQueue])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }, [handleFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!dropZoneRef.current?.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }, [])

  const downloadImage = useCallback((converted: ConvertedImage) => {
    const baseName = converted.originalName.replace(/\.[^.]+$/, '')
    const a = document.createElement('a')
    a.href = converted.previewUrl
    a.download = `${baseName}.webp`
    a.click()
  }, [])

  const downloadAll = useCallback(() => {
    const convertedItems = queue.filter(q => q.converted)
    convertedItems.forEach((q, index) => {
      setTimeout(() => {
        if (q.converted) downloadImage(q.converted)
      }, index * 100)
    })
  }, [queue, downloadImage])

  const clearQueue = useCallback(() => {
    queueRef.current.forEach(q => {
      URL.revokeObjectURL(q.previewUrl)
      if (q.converted) URL.revokeObjectURL(q.converted.previewUrl)
    })
    queueRef.current = []
    setQueue([])
  }, [])

  const removeFromQueue = useCallback((id: string) => {
    const item = queueRef.current.find(q => q.id === id)
    if (item) {
      URL.revokeObjectURL(item.previewUrl)
      if (item.converted) URL.revokeObjectURL(item.converted.previewUrl)
    }
    queueRef.current = queueRef.current.filter(q => q.id !== id)
    setQueue([...queueRef.current])
  }, [])

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  const getSavingsPercent = (original: number, converted: number) => {
    return Math.round((1 - converted / original) * 100)
  }

  const savePreset = useCallback((preset: Preset) => {
    const normalizedPreset = normalizePreset(preset)
    setPresets(prev => {
      const exists = prev.find(p => p.id === normalizedPreset.id)
      if (exists) {
        return prev.map(p => p.id === normalizedPreset.id ? normalizedPreset : p)
      }
      return [...prev, normalizedPreset]
    })
    setSelectedPreset(prev => prev.id === normalizedPreset.id ? normalizedPreset : prev)
    setEditingPreset(null)
    setShowPresetEditor(false)
  }, [])

  const deletePreset = useCallback((id: string) => {
    setPresets(prev => prev.filter(p => p.id !== id))
    if (selectedPreset.id === id) {
      setSelectedPreset(presets[0])
    }
  }, [selectedPreset, presets])

  const completedCount = queue.filter(q => q.status === 'done').length
  const totalSaved = queue.reduce((acc, q) => {
    if (q.converted) {
      return acc + (q.converted.originalSize - q.converted.convertedSize)
    }
    return acc
  }, 0)

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1 className="logo">
            <span className="logo-bracket">[</span>
            WEBP
            <span className="logo-dot">.</span>
            EEZY
            <span className="logo-bracket">]</span>
          </h1>
          <span className="version">v1.0.0</span>
        </div>
        <div className="header-right">
          <div className={`status-indicator ${isProcessing ? 'processing' : ''}`}>
            <span className="status-dot" />
            <span className="status-text">{isProcessing ? 'PROCESSING' : 'READY'}</span>
          </div>
        </div>
      </header>

      <main className="main">
        <section className="control-panel">
          <div className="panel-header">
            <span className="panel-label">// PRESETS</span>
            <button
              className="btn-icon"
              onClick={() => {
                setEditingPreset({
                  id: crypto.randomUUID(),
                  name: '',
                  maxWidth: null,
                  maxHeight: null,
                  quality: 85,
                  reducePercent: 0
                })
                setShowPresetEditor(true)
              }}
              title="Add preset"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/>
              </svg>
            </button>
          </div>

          <div className="presets-grid">
            {presets.map((preset, index) => (
              <motion.button
                key={preset.id}
                className={`preset-btn ${selectedPreset.id === preset.id ? 'active' : ''}`}
                onClick={() => setSelectedPreset(preset)}
                onDoubleClick={() => {
                  setEditingPreset(preset)
                  setShowPresetEditor(true)
                }}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <span className="preset-name">{preset.name}</span>
                <span className="preset-quality">{preset.quality}%</span>
              </motion.button>
            ))}
          </div>

          <div className="preset-details">
            <div className="detail-row">
              <span className="detail-label">MAX_WIDTH:</span>
              <span className="detail-value">{selectedPreset.maxWidth || '---'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">MAX_HEIGHT:</span>
              <span className="detail-value">{selectedPreset.maxHeight || '---'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">REDUCE_BY:</span>
              <span className="detail-value">{selectedPreset.reducePercent}%</span>
            </div>
            <div className="quality-slider-group">
              <label className="form-label">QUALITY: {selectedPreset.quality}%</label>
              <input
                className="form-slider"
                type="range"
                min="1"
                max="100"
                value={selectedPreset.quality}
                onChange={(e) => {
                  const quality = parseInt(e.target.value)
                  const updated = { ...selectedPreset, quality }
                  setSelectedPreset(updated)
                  setPresets(prev => prev.map(p => p.id === updated.id ? updated : p))
                }}
              />
              <div className="slider-labels">
                <span>LOW</span>
                <span>HIGH</span>
              </div>
            </div>
            <div className="quality-slider-group">
              <label className="form-label">REDUCE BY: {selectedPreset.reducePercent}%</label>
              <input
                className="form-slider"
                type="range"
                min="0"
                max="95"
                value={selectedPreset.reducePercent}
                onChange={(e) => {
                  const reducePercent = parseInt(e.target.value)
                  const updated = { ...selectedPreset, reducePercent }
                  setSelectedPreset(updated)
                  setPresets(prev => prev.map(p => p.id === updated.id ? updated : p))
                }}
              />
              <div className="slider-labels">
                <span>NONE</span>
                <span>MAX</span>
              </div>
            </div>
          </div>
        </section>

        <section className="drop-section">
          <div
            ref={dropZoneRef}
            className={`drop-zone ${isDragging ? 'dragging' : ''} ${queue.length > 0 ? 'has-items' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
              style={{ display: 'none' }}
            />

            <AnimatePresence mode="wait">
              {isDragging ? (
                <motion.div
                  key="dragging"
                  className="drop-content"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                >
                  <div className="drop-icon active">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                      <path d="M24 32V16M24 16l-8 8M24 16l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square"/>
                      <rect x="8" y="8" width="32" height="32" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4"/>
                    </svg>
                  </div>
                  <span className="drop-text">RELEASE TO CONVERT</span>
                </motion.div>
              ) : queue.length === 0 ? (
                <motion.div
                  key="empty"
                  className="drop-content"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <div className="drop-icon">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                      <path d="M24 32V16M24 16l-8 8M24 16l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square"/>
                      <rect x="8" y="8" width="32" height="32" stroke="currentColor" strokeWidth="2"/>
                    </svg>
                  </div>
                  <span className="drop-text">DROP IMAGES HERE</span>
                  <span className="drop-hint">or click to browse</span>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {queue.length > 0 && !isDragging && (
              <div className="queue-container" onClick={(e) => e.stopPropagation()}>
                <div className="queue-header">
                  <span className="queue-count">{completedCount}/{queue.length} CONVERTED</span>
                  {totalSaved > 0 && (
                    <span className="queue-saved">-{formatBytes(totalSaved)} SAVED</span>
                  )}
                </div>
                <div className="queue-list">
                  {queue.map((item, index) => (
                    <motion.div
                      key={item.id}
                      className={`queue-item ${item.status}`}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="queue-item-preview">
                        <img src={item.converted?.previewUrl || item.previewUrl} alt="" />
                      </div>
                      <div className="queue-item-info">
                        <span className="queue-item-name">{item.file.name}</span>
                        <div className="queue-item-meta">
                          <span className="queue-item-preset">{item.preset.name}</span>
                          {item.status === 'done' && item.converted && (
                            <>
                              <span className="size-original">{formatBytes(item.converted.originalSize)}</span>
                              <span className="size-arrow">&rarr;</span>
                              <span className="size-converted">{formatBytes(item.converted.convertedSize)}</span>
                              <span className="size-savings">
                                -{getSavingsPercent(item.converted.originalSize, item.converted.convertedSize)}%
                              </span>
                            </>
                          )}
                          {item.status === 'converting' && <span className="status-converting">CONVERTING...</span>}
                          {item.status === 'pending' && <span className="status-pending">PENDING</span>}
                          {item.status === 'error' && <span className="status-error">{item.error}</span>}
                        </div>
                      </div>
                      <div className="queue-item-actions">
                        {item.status === 'done' && item.converted && (
                          <button
                            className="btn-download"
                            onClick={(e) => {
                              e.stopPropagation()
                              downloadImage(item.converted!)
                            }}
                            title="Download"
                          >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                              <path d="M8 3v8M8 11l-3-3M8 11l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/>
                            </svg>
                          </button>
                        )}
                        <button
                          className="btn-remove"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeFromQueue(item.id)
                          }}
                          title="Remove"
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/>
                          </svg>
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {queue.length > 0 && (
            <motion.div
              className="queue-actions"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <button className="btn-secondary" onClick={clearQueue}>
                CLEAR ALL
              </button>
              <button className="btn-primary" onClick={downloadAll} disabled={completedCount === 0}>
                DOWNLOAD ALL ({completedCount})
              </button>
            </motion.div>
          )}
        </section>
      </main>

      <AnimatePresence>
        {showPresetEditor && editingPreset && (
          <motion.div
            className="modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowPresetEditor(false)}
          >
            <motion.div
              className="modal"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <span className="modal-title">
                  {presets.find(p => p.id === editingPreset.id) ? 'EDIT PRESET' : 'NEW PRESET'}
                </span>
                <button className="btn-icon" onClick={() => setShowPresetEditor(false)}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/>
                  </svg>
                </button>
              </div>

              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">NAME</label>
                  <input
                    className="form-input"
                    type="text"
                    value={editingPreset.name}
                    onChange={(e) => setEditingPreset({ ...editingPreset, name: e.target.value })}
                    placeholder="e.g. THUMBNAIL"
                  />
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">MAX WIDTH</label>
                    <input
                      className="form-input"
                      type="number"
                      value={editingPreset.maxWidth || ''}
                      onChange={(e) => setEditingPreset({
                        ...editingPreset,
                        maxWidth: e.target.value ? parseInt(e.target.value) : null
                      })}
                      placeholder="px"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">MAX HEIGHT</label>
                    <input
                      className="form-input"
                      type="number"
                      value={editingPreset.maxHeight || ''}
                      onChange={(e) => setEditingPreset({
                        ...editingPreset,
                        maxHeight: e.target.value ? parseInt(e.target.value) : null
                      })}
                      placeholder="px"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">QUALITY: {editingPreset.quality}%</label>
                  <input
                    className="form-slider"
                    type="range"
                    min="1"
                    max="100"
                    value={editingPreset.quality}
                    onChange={(e) => setEditingPreset({
                      ...editingPreset,
                      quality: parseInt(e.target.value)
                    })}
                  />
                  <div className="slider-labels">
                    <span>LOW</span>
                    <span>HIGH</span>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">REDUCE BY: {editingPreset.reducePercent}%</label>
                  <input
                    className="form-slider"
                    type="range"
                    min="0"
                    max="95"
                    value={editingPreset.reducePercent}
                    onChange={(e) => setEditingPreset({
                      ...editingPreset,
                      reducePercent: parseInt(e.target.value)
                    })}
                  />
                  <div className="slider-labels">
                    <span>NONE</span>
                    <span>MAX</span>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                {presets.find(p => p.id === editingPreset.id) && (
                  <button
                    className="btn-danger"
                    onClick={() => {
                      deletePreset(editingPreset.id)
                      setShowPresetEditor(false)
                    }}
                  >
                    DELETE
                  </button>
                )}
                <div className="modal-footer-right">
                  <button className="btn-secondary" onClick={() => setShowPresetEditor(false)}>
                    CANCEL
                  </button>
                  <button
                    className="btn-primary"
                    onClick={() => savePreset(editingPreset)}
                    disabled={!editingPreset.name.trim()}
                  >
                    SAVE
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default App
