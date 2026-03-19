import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { join } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { exists, writeFile } from '@tauri-apps/plugin-fs'
import { openPath } from '@tauri-apps/plugin-opener'
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
  originalWidth: number
  originalHeight: number
  outputWidth: number
  outputHeight: number
}

interface QueuedImage {
  id: string
  file: File
  previewUrl: string
  preset: Preset
  status: 'pending' | 'converting' | 'done' | 'error'
  converted?: ConvertedImage
  error?: string
  savedPath?: string
  saveError?: string
}

interface Notice {
  kind: 'info' | 'success' | 'error'
  message: string
}

interface SaveProgress {
  current: number
  total: number
}

type EditorMode = 'selected' | 'new'
type QueueStateUpdater = QueuedImage[] | ((current: QueuedImage[]) => QueuedImage[])

const STORAGE_KEYS = {
  presets: 'webp-presets',
  outputDirectory: 'webp-output-directory',
} as const

const IMAGE_FILE_PATTERN = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i

const clamp = (value: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, value))
}

const normalizeDimension = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return Math.round(value)
}

const clonePreset = (preset: Preset): Preset => ({
  ...preset,
})

const normalizePreset = (preset: Partial<Preset>): Preset => ({
  id: typeof preset.id === 'string' && preset.id.trim() ? preset.id : crypto.randomUUID(),
  name: typeof preset.name === 'string' ? preset.name.trim() : '',
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
  {
    id: 'original',
    name: 'Keep Original Size',
    maxWidth: null,
    maxHeight: null,
    quality: 90,
    reducePercent: 0,
  },
  {
    id: 'large',
    name: 'Large Website',
    maxWidth: 1920,
    maxHeight: 1920,
    quality: 86,
    reducePercent: 0,
  },
  {
    id: 'medium',
    name: 'Standard Blog',
    maxWidth: 1280,
    maxHeight: 1280,
    quality: 84,
    reducePercent: 0,
  },
  {
    id: 'small',
    name: 'Small Social',
    maxWidth: 800,
    maxHeight: 800,
    quality: 80,
    reducePercent: 0,
  },
  {
    id: 'thumb',
    name: 'Thumbnail',
    maxWidth: 400,
    maxHeight: 400,
    quality: 76,
    reducePercent: 0,
  },
]

const loadPresets = (): Preset[] => {
  const saved = localStorage.getItem(STORAGE_KEYS.presets)
  if (!saved) {
    return DEFAULT_PRESETS
  }

  try {
    const parsed = JSON.parse(saved)
    if (!Array.isArray(parsed)) {
      return DEFAULT_PRESETS
    }

    const normalizedPresets = parsed.map((preset) => normalizePreset(preset as Partial<Preset>))
    return normalizedPresets.length > 0 ? normalizedPresets : DEFAULT_PRESETS
  } catch {
    return DEFAULT_PRESETS
  }
}

const loadOutputDirectory = () => {
  const saved = localStorage.getItem(STORAGE_KEYS.outputDirectory)
  return saved && saved.trim() ? saved : null
}

const isImageFile = (file: File) => {
  return file.type.startsWith('image/') || IMAGE_FILE_PATTERN.test(file.name)
}

const isTauriRuntime = () => {
  if (typeof window === 'undefined') {
    return false
  }

  return '__TAURI_INTERNALS__' in (window as Window & { __TAURI_INTERNALS__?: unknown })
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const getSavingsPercent = (original: number, converted: number) => {
  return Math.round((1 - converted / original) * 100)
}

const getPresetLimitLabel = (preset: Preset) => {
  if (!preset.maxWidth && !preset.maxHeight) {
    return 'Original dimensions'
  }

  if (preset.maxWidth && preset.maxHeight) {
    return `Up to ${preset.maxWidth} x ${preset.maxHeight}px`
  }

  if (preset.maxWidth) {
    return `Up to ${preset.maxWidth}px wide`
  }

  return `Up to ${preset.maxHeight}px tall`
}

const getPresetDescription = (preset: Preset) => {
  const parts = [getPresetLimitLabel(preset), `${preset.quality}% quality`]

  if (preset.reducePercent > 0) {
    parts.push(`${preset.reducePercent}% smaller`)
  }

  return parts.join(' • ')
}

const getPathSegments = (path: string) => {
  return path.split(/[/\\]/).filter(Boolean)
}

const getPathTail = (path: string) => {
  const segments = getPathSegments(path)
  return segments.at(-1) ?? path
}

const truncatePath = (path: string) => {
  const segments = getPathSegments(path)
  if (segments.length <= 3) {
    return path
  }

  return ['...', ...segments.slice(-3)].join('/')
}

const stripControlCharacters = (value: string) => {
  return Array.from(value)
    .filter((character) => character >= ' ' && character !== '\u007f')
    .join('')
}

const sanitizeFileStem = (name: string) => {
  const stem = stripControlCharacters(name.replace(/\.[^.]+$/, '')).replace(/[<>:"/\\|?*]/g, '-').trim()
  const normalized = stem.replace(/\s+/g, ' ').replace(/[. ]+$/g, '')
  return normalized || 'converted-image'
}

const createPresetDraft = (source?: Preset): Preset => ({
  id: crypto.randomUUID(),
  name: source?.name ? `${source.name} copy` : '',
  maxWidth: source?.maxWidth ?? 1280,
  maxHeight: source?.maxHeight ?? 1280,
  quality: source?.quality ?? 84,
  reducePercent: source?.reducePercent ?? 0,
})

const arePresetsEqual = (left: Preset, right: Preset) => {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.maxWidth === right.maxWidth &&
    left.maxHeight === right.maxHeight &&
    left.quality === right.quality &&
    left.reducePercent === right.reducePercent
  )
}

const revokeQueueItemUrls = (item: QueuedImage) => {
  URL.revokeObjectURL(item.previewUrl)
  if (item.converted) {
    URL.revokeObjectURL(item.converted.previewUrl)
  }
}

const isCompletedItem = (item: QueuedImage): item is QueuedImage & { converted: ConvertedImage } => {
  return item.status === 'done' && Boolean(item.converted)
}

const convertToWebP = async (file: File, preset: Preset): Promise<ConvertedImage> => {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const sourceUrl = URL.createObjectURL(file)

    img.onload = () => {
      if (!ctx) {
        URL.revokeObjectURL(sourceUrl)
        reject(new Error('Your browser could not start the image converter.'))
        return
      }

      let width = img.width
      let height = img.height
      const originalWidth = width
      const originalHeight = height

      if (preset.reducePercent > 0) {
        const ratio = (100 - preset.reducePercent) / 100
        width = Math.max(1, Math.round(width * ratio))
        height = Math.max(1, Math.round(height * ratio))
      }

      if (preset.maxWidth || preset.maxHeight) {
        const maxWidth = preset.maxWidth || Infinity
        const maxHeight = preset.maxHeight || Infinity
        const ratio = Math.min(maxWidth / width, maxHeight / height)

        if (ratio < 1) {
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
      }

      canvas.width = width
      canvas.height = height
      ctx.drawImage(img, 0, 0, width, height)

      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(sourceUrl)

          if (!blob) {
            reject(new Error('We could not create a WebP file for this image.'))
            return
          }

          const previewUrl = URL.createObjectURL(blob)

          resolve({
            id: crypto.randomUUID(),
            originalName: file.name,
            originalSize: file.size,
            convertedSize: blob.size,
            blob,
            previewUrl,
            preset,
            originalWidth,
            originalHeight,
            outputWidth: width,
            outputHeight: height,
          })
        },
        'image/webp',
        preset.quality / 100
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(sourceUrl)
      reject(new Error('We could not read this image.'))
    }

    img.src = sourceUrl
  })
}

function App() {
  const initialState = useRef((() => {
    const loadedPresets = loadPresets()
    const firstPreset = clonePreset(loadedPresets[0] ?? DEFAULT_PRESETS[0])

    return {
      presets: loadedPresets,
      firstPreset,
      outputDirectory: loadOutputDirectory(),
    }
  })()).current

  const [presets, setPresets] = useState<Preset[]>(initialState.presets)
  const [selectedPresetId, setSelectedPresetId] = useState(initialState.firstPreset.id)
  const [presetDraft, setPresetDraft] = useState<Preset>(initialState.firstPreset)
  const [editorMode, setEditorMode] = useState<EditorMode>('selected')
  const [queue, setQueue] = useState<QueuedImage[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [outputDirectory, setOutputDirectory] = useState<string | null>(initialState.outputDirectory)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const queueRef = useRef<QueuedImage[]>([])
  const isProcessingRef = useRef(false)

  const updateQueue = (updater: QueueStateUpdater) => {
    const nextQueue = typeof updater === 'function' ? updater(queueRef.current) : updater
    queueRef.current = nextQueue
    setQueue(nextQueue)
  }

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? presets[0] ?? DEFAULT_PRESETS[0]
  const isSelectedDraftDirty = editorMode === 'selected' && !arePresetsEqual(selectedPreset, presetDraft)
  const nativeExportAvailable = isTauriRuntime()
  const completedCount = queue.filter((item) => item.status === 'done').length
  const pendingCount = queue.filter((item) => item.status === 'pending').length
  const convertingCount = queue.filter((item) => item.status === 'converting').length
  const errorCount = queue.filter((item) => item.status === 'error').length
  const savedCount = queue.filter((item) => item.savedPath).length
  const unsavedCompletedCount = queue.filter((item) => isCompletedItem(item) && !item.savedPath).length
  const totalSaved = queue.reduce((accumulator, item) => {
    if (item.converted) {
      return accumulator + (item.converted.originalSize - item.converted.convertedSize)
    }

    return accumulator
  }, 0)
  const progressPercent = queue.length
    ? Math.round(((completedCount + errorCount) / queue.length) * 100)
    : 0
  const convertingPosition = queue.findIndex((item) => item.status === 'converting') + 1
  const canSaveDraft = presetDraft.name.trim().length > 0 && (editorMode === 'new' || isSelectedDraftDirty)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.presets, JSON.stringify(presets))
  }, [presets])

  useEffect(() => {
    if (outputDirectory) {
      localStorage.setItem(STORAGE_KEYS.outputDirectory, outputDirectory)
      return
    }

    localStorage.removeItem(STORAGE_KEYS.outputDirectory)
  }, [outputDirectory])

  useEffect(() => {
    return () => {
      queueRef.current.forEach((item) => revokeQueueItemUrls(item))
    }
  }, [])

  useEffect(() => {
    const nextSelectedPreset = presets.find((preset) => preset.id === selectedPresetId)
    if (nextSelectedPreset) {
      return
    }

    const fallbackPreset = presets[0] ?? DEFAULT_PRESETS[0]
    setSelectedPresetId(fallbackPreset.id)

    if (editorMode === 'selected') {
      setPresetDraft(clonePreset(fallbackPreset))
    }
  }, [editorMode, presets, selectedPresetId])

  const syncSelectedPreset = (nextPreset: Preset) => {
    setSelectedPresetId(nextPreset.id)
    setEditorMode('selected')
    setPresetDraft(clonePreset(nextPreset))
  }

  const resetSavedState = (currentQueue: QueuedImage[]) => {
    return currentQueue.map((item) => {
      if (!item.savedPath && !item.saveError) {
        return item
      }

      return {
        ...item,
        savedPath: undefined,
        saveError: undefined,
      }
    })
  }

  const applyOutputDirectory = (nextDirectory: string | null) => {
    setOutputDirectory(nextDirectory)
    updateQueue((currentQueue) => resetSavedState(currentQueue))
  }

  const processQueue = async () => {
    if (isProcessingRef.current) {
      return
    }

    isProcessingRef.current = true
    setIsProcessing(true)

    while (true) {
      const nextItem = queueRef.current.find((item) => item.status === 'pending')

      if (!nextItem) {
        isProcessingRef.current = false
        setIsProcessing(false)
        return
      }

      updateQueue((currentQueue) =>
        currentQueue.map((item) =>
          item.id === nextItem.id
            ? { ...item, status: 'converting', error: undefined }
            : item
        )
      )

      try {
        const converted = await convertToWebP(nextItem.file, nextItem.preset)

        updateQueue((currentQueue) =>
          currentQueue.map((item) => {
            if (item.id !== nextItem.id) {
              return item
            }

            if (item.converted) {
              URL.revokeObjectURL(item.converted.previewUrl)
            }

            return {
              ...item,
              status: 'done',
              converted,
              error: undefined,
              savedPath: undefined,
              saveError: undefined,
            }
          })
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Something went wrong while converting this image.'

        updateQueue((currentQueue) =>
          currentQueue.map((item) =>
            item.id === nextItem.id
              ? {
                  ...item,
                  status: 'error',
                  error: message,
                  saveError: undefined,
                  savedPath: undefined,
                }
              : item
          )
        )
      }
    }
  }

  const chooseOutputDirectory = async () => {
    if (!nativeExportAvailable) {
      setNotice({
        kind: 'info',
        message: 'Folder picking is available in the desktop app. In the browser, converted files download normally.',
      })
      return null
    }

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose a folder for converted images',
        defaultPath: outputDirectory ?? undefined,
      })

      if (typeof selected !== 'string' || !selected.trim()) {
        return null
      }

      applyOutputDirectory(selected)
      setNotice({
        kind: 'success',
        message: `New exports will save to ${truncatePath(selected)}.`,
      })

      return selected
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'We could not open the folder picker.',
      })
      return null
    }
  }

  const handleFiles = (files: FileList | File[]) => {
    const incomingFiles = Array.from(files)
    const imageFiles = incomingFiles.filter((file) => isImageFile(file))
    const skippedCount = incomingFiles.length - imageFiles.length

    if (imageFiles.length === 0) {
      setNotice({
        kind: 'info',
        message: 'Only image files can be converted here. Try PNG, JPG, GIF, TIFF, SVG, or WebP files.',
      })
      return
    }

    const newItems: QueuedImage[] = imageFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      preset: clonePreset(selectedPreset),
      status: 'pending',
    }))

    updateQueue((currentQueue) => [...currentQueue, ...newItems])
    void processQueue()

    if (skippedCount > 0) {
      const label = skippedCount === 1 ? 'file was' : 'files were'
      setNotice({
        kind: 'info',
        message: `${skippedCount} ${label} skipped because only images can be converted.`,
      })
    } else {
      setNotice(null)
    }
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setIsDragging(false)
    handleFiles(event.dataTransfer.files)
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault()

    if (!dropZoneRef.current?.contains(event.relatedTarget as Node | null)) {
      setIsDragging(false)
    }
  }

  const triggerFilePicker = () => {
    fileInputRef.current?.click()
  }

  const downloadImage = (converted: ConvertedImage) => {
    const baseName = sanitizeFileStem(converted.originalName)
    const anchor = document.createElement('a')
    anchor.href = converted.previewUrl
    anchor.download = `${baseName}.webp`
    anchor.click()
  }

  const getUniqueOutputPath = async (directory: string, originalName: string, reservedNames: Set<string>) => {
    const baseName = sanitizeFileStem(originalName)
    let suffix = ''
    let counter = 2

    while (true) {
      const fileName = `${baseName}${suffix}.webp`
      const normalizedName = fileName.toLowerCase()

      if (reservedNames.has(normalizedName)) {
        suffix = `-${counter}`
        counter += 1
        continue
      }

      const outputPath = await join(directory, fileName)
      if (!(await exists(outputPath))) {
        reservedNames.add(normalizedName)
        return outputPath
      }

      suffix = `-${counter}`
      counter += 1
    }
  }

  const saveCompletedItem = async (
    item: QueuedImage & { converted: ConvertedImage },
    directory: string,
    reservedNames: Set<string>
  ) => {
    const outputPath = await getUniqueOutputPath(directory, item.converted.originalName, reservedNames)
    const data = new Uint8Array(await item.converted.blob.arrayBuffer())

    await writeFile(outputPath, data)
    return outputPath
  }

  const exportItems = async (items: Array<QueuedImage & { converted: ConvertedImage }>, openFolderAfterSave: boolean) => {
    if (items.length === 0) {
      setNotice({
        kind: 'info',
        message: 'Nothing is ready to save yet. Finish converting at least one image first.',
      })
      return
    }

    if (!nativeExportAvailable) {
      items.forEach((item, index) => {
        window.setTimeout(() => {
          downloadImage(item.converted)
        }, index * 120)
      })

      setNotice({
        kind: 'success',
        message: `Downloaded ${items.length} converted image${items.length === 1 ? '' : 's'}.`,
      })
      return
    }

    let targetDirectory = outputDirectory
    if (!targetDirectory) {
      targetDirectory = await chooseOutputDirectory()
    }

    if (!targetDirectory) {
      return
    }

    setSaveProgress({ current: 0, total: items.length })

    let saved = 0
    let failed = 0
    const reservedNames = new Set<string>()

    for (const [index, item] of items.entries()) {
      try {
        const savedPath = await saveCompletedItem(item, targetDirectory, reservedNames)
        saved += 1

        updateQueue((currentQueue) =>
          currentQueue.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  savedPath,
                  saveError: undefined,
                }
              : entry
          )
        )
      } catch (error) {
        failed += 1

        updateQueue((currentQueue) =>
          currentQueue.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  saveError: error instanceof Error ? error.message : 'This image could not be saved.',
                }
              : entry
          )
        )
      } finally {
        setSaveProgress({ current: index + 1, total: items.length })
      }
    }

    setSaveProgress(null)

    if (saved > 0 && failed === 0) {
      setNotice({
        kind: 'success',
        message: `Saved ${saved} image${saved === 1 ? '' : 's'} to ${truncatePath(targetDirectory)}.`,
      })
    } else if (saved > 0) {
      setNotice({
        kind: 'info',
        message: `Saved ${saved} image${saved === 1 ? '' : 's'}, but ${failed} still need${failed === 1 ? 's' : ''} attention.`,
      })
    } else {
      setNotice({
        kind: 'error',
        message: 'We could not save any converted images. Try choosing a different folder.',
      })
    }

    if (saved > 0 && openFolderAfterSave) {
      try {
        await openPath(targetDirectory)
      } catch {
        setNotice({
          kind: failed > 0 ? 'info' : 'success',
          message: `Saved ${saved} image${saved === 1 ? '' : 's'} to ${truncatePath(targetDirectory)}.`,
        })
      }
    }
  }

  const saveAllConverted = async () => {
    const items = queueRef.current.filter(
      (item): item is QueuedImage & { converted: ConvertedImage } => isCompletedItem(item) && !item.savedPath
    )

    await exportItems(items, true)
  }

  const saveSingleConverted = async (id: string) => {
    const item = queueRef.current.find((entry) => entry.id === id)
    if (!item || !isCompletedItem(item)) {
      return
    }

    await exportItems([item], false)
  }

  const retryItem = (id: string) => {
    updateQueue((currentQueue) =>
      currentQueue.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'pending',
              error: undefined,
              saveError: undefined,
              savedPath: undefined,
            }
          : item
      )
    )

    void processQueue()
  }

  const removeFromQueue = (id: string) => {
    const item = queueRef.current.find((entry) => entry.id === id)
    if (item) {
      revokeQueueItemUrls(item)
    }

    updateQueue((currentQueue) => currentQueue.filter((entry) => entry.id !== id))
  }

  const clearQueue = () => {
    queueRef.current.forEach((item) => revokeQueueItemUrls(item))
    updateQueue([])
    setNotice(null)
  }

  const selectPreset = (preset: Preset) => {
    syncSelectedPreset(preset)
  }

  const startNewPreset = () => {
    setEditorMode('new')
    setPresetDraft(createPresetDraft(selectedPreset))
  }

  const cancelNewPreset = () => {
    syncSelectedPreset(selectedPreset)
  }

  const savePresetDraft = () => {
    const normalizedPreset = normalizePreset(presetDraft)

    if (editorMode === 'new') {
      const nextPresets = [...presets, normalizedPreset]
      setPresets(nextPresets)
      syncSelectedPreset(normalizedPreset)
      setNotice({
        kind: 'success',
        message: `Saved the "${normalizedPreset.name}" preset.`,
      })
      return
    }

    const nextPresets = presets.map((preset) =>
      preset.id === normalizedPreset.id ? normalizedPreset : preset
    )

    setPresets(nextPresets)
    syncSelectedPreset(normalizedPreset)
    setNotice({
      kind: 'success',
      message: `Updated the "${normalizedPreset.name}" preset.`,
    })
  }

  const resetDraft = () => {
    if (editorMode === 'new') {
      setPresetDraft(createPresetDraft(selectedPreset))
      return
    }

    setPresetDraft(clonePreset(selectedPreset))
  }

  const deleteSelectedPreset = () => {
    if (editorMode !== 'selected') {
      return
    }

    const filteredPresets = presets.filter((preset) => preset.id !== selectedPreset.id)
    const nextPresets = filteredPresets.length > 0 ? filteredPresets : DEFAULT_PRESETS
    const nextSelectedPreset = clonePreset(nextPresets[0])

    setPresets(nextPresets)
    setSelectedPresetId(nextSelectedPreset.id)
    setPresetDraft(nextSelectedPreset)
    setEditorMode('selected')
    setNotice({
      kind: 'success',
      message: `Removed the "${selectedPreset.name}" preset.`,
    })
  }

  const openExportFolder = async () => {
    if (!outputDirectory || !nativeExportAvailable) {
      return
    }

    try {
      await openPath(outputDirectory)
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'We could not open that folder.',
      })
    }
  }

  const openSavedItem = async (path: string) => {
    try {
      await openPath(path)
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'We could not open that saved file.',
      })
    }
  }

  const clearExportFolder = () => {
    applyOutputDirectory(null)
    setNotice({
      kind: 'info',
      message: 'The saved export folder was cleared. You can choose a new one any time.',
    })
  }

  let statusTone: 'ready' | 'processing' | 'saving' | 'error' = 'ready'
  let statusTitle = 'Ready to convert'
  let statusDescription = 'Pick a preset, then drop images anywhere in the workspace.'

  if (saveProgress) {
    statusTone = 'saving'
    statusTitle = `Saving ${saveProgress.current} of ${saveProgress.total}`
    statusDescription = outputDirectory
      ? `Writing files to ${getPathTail(outputDirectory)}.`
      : 'Writing converted files to your chosen folder.'
  } else if (isProcessing) {
    statusTone = 'processing'
    statusTitle = `Converting ${convertingPosition || completedCount + 1} of ${queue.length}`
    statusDescription = `${completedCount} finished, ${pendingCount} waiting${errorCount ? `, ${errorCount} need attention` : ''}.`
  } else if (queue.length > 0 && errorCount > 0) {
    statusTone = 'error'
    statusTitle = 'Some images need attention'
    statusDescription = `${completedCount} ready, ${errorCount} failed. You can retry only the problem items.`
  } else if (queue.length > 0) {
    statusTitle = `${completedCount} image${completedCount === 1 ? '' : 's'} ready`
    statusDescription = savedCount > 0
      ? `${savedCount} already saved${unsavedCompletedCount ? `, ${unsavedCompletedCount} still ready to save` : ''}.`
      : `${formatBytes(totalSaved)} smaller across the finished batch.`
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-copy">
          <span className="eyebrow">Desktop WebP converter</span>
          <h1 className="logo">WebPeezy</h1>
          <p className="subtitle">Drop images, choose a preset, and save the whole batch to one folder.</p>
        </div>

        <div className={`status-card ${statusTone}`} aria-live="polite">
          <span className="status-pill">{statusTitle}</span>
          <p className="status-description">{statusDescription}</p>

          {queue.length > 0 && !saveProgress && (
            <div className="status-progress" aria-hidden="true">
              <span className="status-progress-bar" style={{ width: `${progressPercent}%` }} />
            </div>
          )}
        </div>
      </header>

      <main className="main">
        <aside className="control-panel">
          <section className="panel-section">
            <div className="section-heading">
              <div className="panel-heading-copy">
                <span className="panel-label">Presets</span>
                <p className="panel-copy">Choose a starting point before you add images to the queue.</p>
              </div>

              <button className="btn-secondary btn-compact" onClick={startNewPreset}>
                New preset
              </button>
            </div>

            <div className="presets-grid">
              {presets.map((preset, index) => (
                <motion.button
                  key={preset.id}
                  className={`preset-card ${selectedPreset.id === preset.id ? 'active' : ''}`}
                  onClick={() => selectPreset(preset)}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04 }}
                >
                  <div className="preset-card-top">
                    <span className="preset-name">{preset.name}</span>
                    {selectedPreset.id === preset.id && <span className="preset-chip">Selected</span>}
                  </div>
                  <span className="preset-meta">{getPresetDescription(preset)}</span>
                </motion.button>
              ))}
            </div>
          </section>

          <section className="panel-section editor-card">
            <div className="section-heading">
              <div className="panel-heading-copy">
                <span className="panel-label">{editorMode === 'new' ? 'New preset' : 'Preset editor'}</span>
                <p className="panel-copy">
                  {editorMode === 'new'
                    ? 'Start from the current preset and save a reusable version when it feels right.'
                    : isSelectedDraftDirty
                      ? 'Unsaved changes stay in the editor until you click save.'
                      : 'Fine-tune this preset without affecting your queued images.'}
                </p>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="preset-name">
                Preset name
              </label>
              <input
                id="preset-name"
                className="form-input"
                type="text"
                value={presetDraft.name}
                onChange={(event) => setPresetDraft({ ...presetDraft, name: event.target.value })}
                placeholder="Example: Marketing hero"
              />
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label" htmlFor="preset-width">
                  Max width
                </label>
                <input
                  id="preset-width"
                  className="form-input"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={presetDraft.maxWidth ?? ''}
                  onChange={(event) =>
                    setPresetDraft({
                      ...presetDraft,
                      maxWidth: event.target.value ? parseInt(event.target.value, 10) : null,
                    })
                  }
                  placeholder="No limit"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="preset-height">
                  Max height
                </label>
                <input
                  id="preset-height"
                  className="form-input"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={presetDraft.maxHeight ?? ''}
                  onChange={(event) =>
                    setPresetDraft({
                      ...presetDraft,
                      maxHeight: event.target.value ? parseInt(event.target.value, 10) : null,
                    })
                  }
                  placeholder="No limit"
                />
              </div>
            </div>

            <div className="form-group">
              <div className="slider-row">
                <label className="form-label" htmlFor="preset-quality">
                  Quality
                </label>
                <span className="slider-value">{presetDraft.quality}%</span>
              </div>
              <input
                id="preset-quality"
                className="form-slider"
                type="range"
                min="1"
                max="100"
                value={presetDraft.quality}
                onChange={(event) =>
                  setPresetDraft({
                    ...presetDraft,
                    quality: parseInt(event.target.value, 10),
                  })
                }
              />
              <div className="slider-labels">
                <span>Smaller file</span>
                <span>Sharper image</span>
              </div>
            </div>

            <div className="form-group">
              <div className="slider-row">
                <label className="form-label" htmlFor="preset-resize">
                  Resize by percentage
                </label>
                <span className="slider-value">{presetDraft.reducePercent}%</span>
              </div>
              <input
                id="preset-resize"
                className="form-slider"
                type="range"
                min="0"
                max="95"
                value={presetDraft.reducePercent}
                onChange={(event) =>
                  setPresetDraft({
                    ...presetDraft,
                    reducePercent: parseInt(event.target.value, 10),
                  })
                }
              />
              <div className="slider-labels">
                <span>No resize</span>
                <span>Much smaller</span>
              </div>
            </div>

            <p className="helper-text">
              Unsaved preset edits will not change images already in the queue.
            </p>

            <div className="editor-actions">
              {editorMode === 'selected' ? (
                <>
                  <button className="btn-danger btn-compact" onClick={deleteSelectedPreset}>
                    Delete preset
                  </button>

                  <div className="editor-actions-right">
                    <button className="btn-secondary btn-compact" onClick={resetDraft}>
                      Reset
                    </button>
                    <button className="btn-primary btn-compact" onClick={savePresetDraft} disabled={!canSaveDraft}>
                      Save changes
                    </button>
                  </div>
                </>
              ) : (
                <div className="editor-actions-right solo">
                  <button className="btn-secondary btn-compact" onClick={cancelNewPreset}>
                    Cancel
                  </button>
                  <button className="btn-primary btn-compact" onClick={savePresetDraft} disabled={!canSaveDraft}>
                    Save preset
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="panel-section export-card">
            <div className="section-heading">
              <div className="panel-heading-copy">
                <span className="panel-label">Export folder</span>
                <p className="panel-copy">
                  {nativeExportAvailable
                    ? 'Pick a destination once and open it automatically after each batch save.'
                    : 'In the browser, finished files download instead of saving to a chosen folder.'}
                </p>
              </div>

              {nativeExportAvailable && (
                <button className="btn-secondary btn-compact" onClick={() => void chooseOutputDirectory()}>
                  {outputDirectory ? 'Change folder' : 'Choose folder'}
                </button>
              )}
            </div>

            {outputDirectory ? (
              <>
                <div className="path-badge">
                  <span>{getPathTail(outputDirectory)}</span>
                  <small>{truncatePath(outputDirectory)}</small>
                </div>

                <div className="editor-actions-right solo">
                  <button className="btn-secondary btn-compact" onClick={() => void openExportFolder()}>
                    Open folder
                  </button>
                  <button className="btn-secondary btn-compact" onClick={clearExportFolder}>
                    Clear
                  </button>
                </div>
              </>
            ) : (
              <p className="helper-text">
                {nativeExportAvailable
                  ? 'If you do not choose a folder now, WebPeezy will ask for one when you save your batch.'
                  : 'No extra setup needed here when you are previewing the app in a browser.'}
              </p>
            )}
          </section>
        </aside>

        <section className="workspace">
          <AnimatePresence>
            {notice && (
              <motion.div
                className={`notice ${notice.kind}`}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                aria-live="polite"
              >
                <span className="notice-copy">{notice.message}</span>
                <button
                  className="notice-dismiss"
                  type="button"
                  aria-label="Dismiss message"
                  onClick={() => setNotice(null)}
                >
                  ×
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="workspace-summary">
            <div className="summary-card">
              <span className="summary-label">Selected preset</span>
              <strong className="summary-value">{selectedPreset.name}</strong>
              <span className="summary-copy">{getPresetDescription(selectedPreset)}</span>
            </div>

            <div className="summary-card">
              <span className="summary-label">Queue progress</span>
              <strong className="summary-value">
                {queue.length === 0 ? 'Nothing queued yet' : `${completedCount}/${queue.length} converted`}
              </strong>
              <span className="summary-copy">
                {queue.length === 0
                  ? 'New images use the selected preset above.'
                  : `${formatBytes(totalSaved)} saved so far${convertingCount ? ` • ${convertingCount} converting` : ''}.`}
              </span>
            </div>

            <div className="summary-card">
              <span className="summary-label">Export destination</span>
              <strong className="summary-value">
                {outputDirectory ? getPathTail(outputDirectory) : nativeExportAvailable ? 'Choose a folder later' : 'Downloads in browser'}
              </strong>
              <span className="summary-copy">
                {outputDirectory
                  ? 'Finished saves can open this folder automatically.'
                  : nativeExportAvailable
                    ? 'You will be prompted for a folder when you save.'
                    : 'Use the desktop app for native folder export.'}
              </span>
            </div>
          </div>

          <div
            ref={dropZoneRef}
            className={`drop-zone ${isDragging ? 'dragging' : ''} ${queue.length > 0 ? 'has-items' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={triggerFilePicker}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                triggerFilePicker()
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Add images to convert"
          >
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                if (event.target.files) {
                  handleFiles(event.target.files)
                }
                event.target.value = ''
              }}
            />

            <AnimatePresence mode="wait">
              {queue.length === 0 ? (
                <motion.div
                  key={isDragging ? 'dragging' : 'empty'}
                  className="drop-empty"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                >
                  <div className={`drop-icon ${isDragging ? 'active' : ''}`}>
                    <svg width="54" height="54" viewBox="0 0 54 54" fill="none" aria-hidden="true">
                      <path d="M27 36V16M27 16l-8 8M27 16l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      <rect x="9" y="9" width="36" height="36" rx="10" stroke="currentColor" strokeWidth="2" />
                    </svg>
                  </div>
                  <h2 className="drop-title">
                    {isDragging ? 'Drop images to start converting' : 'Drop images here or browse your files'}
                  </h2>
                  <p className="drop-hint">
                    WebPeezy keeps your chosen preset front and center, then saves the finished batch wherever you want.
                  </p>
                  <button
                    className="btn-primary drop-cta"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      triggerFilePicker()
                    }}
                  >
                    Choose images
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="queue"
                  className="queue-shell"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="queue-toolbar">
                    <div className="queue-heading">
                      <h2 className="queue-title">Conversion queue</h2>
                      <p className="queue-subtitle">
                        {completedCount} finished, {pendingCount} waiting, {errorCount} with issues.
                      </p>
                    </div>

                    <button
                      className="btn-secondary btn-compact"
                      type="button"
                      onClick={triggerFilePicker}
                    >
                      Add images
                    </button>
                  </div>

                  <div className="queue-list">
                    {queue.map((item, index) => (
                      <motion.div
                        key={item.id}
                        className={`queue-item ${item.status}`}
                        initial={{ opacity: 0, x: -16 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.03 }}
                      >
                        <div className="queue-item-preview">
                          <img
                            src={item.converted?.previewUrl || item.previewUrl}
                            alt={`${item.file.name} preview`}
                          />
                        </div>

                        <div className="queue-item-main">
                          <div className="queue-item-top">
                            <span className="queue-item-name">{item.file.name}</span>
                            <span className={`queue-status ${item.status}`}>
                              {item.status === 'done'
                                ? item.savedPath
                                  ? 'Saved'
                                  : 'Ready'
                                : item.status === 'converting'
                                  ? 'Converting'
                                  : item.status === 'pending'
                                    ? 'Queued'
                                    : 'Needs retry'}
                            </span>
                          </div>

                          <div className="queue-meta">
                            <span className="queue-meta-item">{item.preset.name}</span>
                            <span className="queue-meta-item">{formatBytes(item.file.size)}</span>
                            {item.converted && (
                              <>
                                <span className="queue-meta-item">
                                  {item.converted.originalWidth} x {item.converted.originalHeight}
                                  {' → '}
                                  {item.converted.outputWidth} x {item.converted.outputHeight}
                                </span>
                                <span className="queue-meta-item">
                                  {formatBytes(item.converted.convertedSize)} •
                                  {' '}
                                  {getSavingsPercent(item.converted.originalSize, item.converted.convertedSize)}% smaller
                                </span>
                              </>
                            )}
                          </div>

                          {item.status === 'error' && item.error && (
                            <span className="queue-note error">{item.error}</span>
                          )}
                          {item.savedPath && (
                            <span className="queue-note success">
                              Saved to {getPathTail(item.savedPath)}
                            </span>
                          )}
                          {item.saveError && (
                            <span className="queue-note error">{item.saveError}</span>
                          )}
                        </div>

                        <div className="queue-item-actions">
                          {item.status === 'error' && (
                            <button
                              className="btn-secondary btn-compact"
                              type="button"
                              onClick={() => retryItem(item.id)}
                            >
                              Retry
                            </button>
                          )}

                          {item.status === 'done' && item.converted && !item.savedPath && (
                            <button
                              className="btn-secondary btn-compact"
                              type="button"
                              onClick={() => void saveSingleConverted(item.id)}
                            >
                              {nativeExportAvailable ? 'Save' : 'Download'}
                            </button>
                          )}

                          {item.savedPath && nativeExportAvailable && (
                            <button
                              className="btn-secondary btn-compact"
                              type="button"
                              onClick={() => void openSavedItem(item.savedPath!)}
                            >
                              Open
                            </button>
                          )}

                          <button
                            className="btn-secondary btn-compact"
                            type="button"
                            onClick={() => removeFromQueue(item.id)}
                            aria-label={`Remove ${item.file.name} from the queue`}
                          >
                            Remove
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {queue.length > 0 && (
            <div className="queue-actions">
              <button className="btn-secondary" onClick={clearQueue} disabled={isProcessing || Boolean(saveProgress)}>
                Clear queue
              </button>

              <button
                className="btn-primary"
                onClick={() => void saveAllConverted()}
                disabled={unsavedCompletedCount === 0 || isProcessing || Boolean(saveProgress)}
              >
                {nativeExportAvailable
                  ? outputDirectory
                    ? `Save ${unsavedCompletedCount} ready image${unsavedCompletedCount === 1 ? '' : 's'}`
                    : `Choose folder & save ${unsavedCompletedCount}`
                  : `Download ${unsavedCompletedCount} ready image${unsavedCompletedCount === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
