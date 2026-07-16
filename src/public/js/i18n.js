const STORAGE_KEY = 'puma-locale';

const dictionaries = {
  en: {
    'common.pressKey': 'Press a key...',
    'common.remove': 'Remove',
    'common.copy': 'Copy',
    'common.cancel': 'Cancel',

    'header.stopAllTitle': 'Stop all',
    'header.stopKeyCaptureTitle': 'Click to set stop key',
    'header.sessionNamePlaceholder': 'session name',
    'header.save': 'Save',
    'header.loadSessionOption': 'Load session...',
    'header.new': 'New',
    'header.export': 'Export',
    'header.exportTitle': 'Export session as ZIP',
    'header.import': 'Import',
    'header.importTitle': 'Import session from ZIP',
    'header.localeSelectTitle': 'Language',

    'master.volume': 'Volume',
    'master.cutoff': 'Cutoff',
    'master.resonance': 'Res',
    'master.reverb': 'Reverb',
    'master.delayTime': 'D.Time',
    'master.delayFeedback': 'D.FB',
    'tip.volume': 'Overall output volume.',
    'tip.cutoff': 'Low-pass filter cutoff frequency. Lower values sound darker/muffled.',
    'tip.resonance': 'Emphasizes frequencies near the filter cutoff.',
    'tip.reverb': 'Adds space/ambience to the sound. 0% is fully dry.',
    'tip.delayTime': 'Time in milliseconds between each echo repeat.',
    'tip.delayFeedback': 'How many times the echo repeats before fading out.',
    'tip.gridSize': 'Shrinking the grid discards any extra PADs that no longer fit.',
    'tip.stopKeyCapture': 'Click, then press a key to set it as the global stop shortcut.',
    'tip.addVideo': 'Only YouTube links are supported. Downloads happen in the background.',
    'tip.triggerMode': 'One-shot plays the full sample once per press. Gate plays only while the key is held down.',
    'tip.waveformHelp': 'Ctrl + Wheel = zoom\nDrag empty area = pan\nI = Set In\nO = Set Out\nSpace = Play / Pause\nDrag handles = adjust start / end\nClick waveform = seek',

    'video.placeholder': 'Add a video and assign it to a pad',
    'video.urlPlaceholder': 'https://youtube.com/watch?v=...',
    'video.addButton': 'Add Video',
    'video.status.ready': 'Ready',
    'video.status.downloading': 'Downloading',
    'video.status.queued': 'Queued',
    'video.status.error': 'Error',

    'panel.padEditorTitle': 'PAD Editor',
    'panel.videoLibraryTitle': 'Video Library',
    'panel.collapseTitle': 'Collapse panel',
    'panel.expandTitle': 'Expand panel',
    'library.toggleTitle': 'Toggle Video Library',
    'library.toggleLabel': 'Videos',

    'toast.stopKeySet': 'Stop key set to {key}',
    'toast.allStopped': 'All stopped',
    'toast.padsResized': 'PADS resized to {n}',
    'toast.videoNotLoaded': 'Video not loaded',
    'toast.audioLoadFailed': 'Audio load failed: {message}',
    'toast.previewLoadFailed': 'Preview video failed to load',
    'toast.previewPlayFailed': 'Preview play failed',
    'toast.assignKeyFirst': 'Assign a key first',
    'toast.selectVideoFirst': 'Select a video first',
    'toast.endAfterStart': 'End must be after start',
    'toast.padUpdated': 'PAD {position} updated',
    'toast.videosLoadFailed': 'Failed to load videos: {message}',
    'toast.videoRemoved': 'Removed {name}',
    'toast.removeFailed': 'Remove failed: {message}',
    'toast.videoAlreadyAvailable': 'Video already available',
    'toast.videoQueued': 'Video queued for download',
    'toast.addFailed': 'Add failed: {message}',
    'toast.saveOrLoadBeforeExport': 'Save or load a session before exporting',
    'toast.appReady': 'PumaSamplerMusic ready',
    'toast.enterSessionName': 'Enter a session name',
    'toast.sessionSaved': 'Session "{name}" saved',
    'toast.sessionSaveFailed': 'Save failed: {message}',
    'toast.sessionLoaded': 'Session "{name}" loaded',
    'toast.sessionLoadFailed': 'Load failed: {message}',
    'toast.sessionImported': 'Session "{name}" imported',
    'toast.sessionImportFailed': 'Import failed: {message}',
    'toast.sessionImportVideosFailed': '{count} video(s) from the imported session could not be found on YouTube',
    'toast.selectSessionToCopy': 'Select a session to copy',
    'toast.sessionCopied': 'Session copied. Enter a new name and save.',
    'toast.importSelectZip': 'Select a session ZIP file to import',

    'editor.clickPadToEdit': 'Click a pad to edit',
    'editor.labelField': 'Label',
    'editor.labelPlaceholder': 'Kick, Bass, etc.',
    'editor.keyField': 'Key',
    'editor.clickPressKey': 'Click and press a key',
    'editor.keyValue': 'Key: {key}',
    'editor.videoField': 'Video',
    'editor.selectVideo': 'Select a video...',
    'editor.previewField': 'Preview',
    'editor.transportField': 'Transport',
    'editor.playTitle': 'Play preview (Space)',
    'editor.pauseTitle': 'Pause preview (Space)',
    'editor.stopTitle': 'Stop preview',
    'editor.setInTitle': 'Set In point at current position',
    'editor.setOutTitle': 'Set Out point at current position',
    'editor.setIn': 'Set In [I]',
    'editor.setOut': 'Set Out [O]',
    'editor.startField': 'Start',
    'editor.endField': 'End',
    'editor.previewVolumeField': 'Preview Volume',
    'editor.padVolumeField': 'PAD Volume',
    'editor.triggerModeField': 'Trigger Mode',
    'editor.oneshotOption': 'One-shot (press once)',
    'editor.gateOption': 'Gate (while held)',
    'editor.colorField': 'Color',
    'editor.loopField': 'Loop',
    'editor.applyButton': 'Apply to PAD',

    'waveform.label': 'Waveform',
    'waveform.zoomOutTitle': 'Zoom out',
    'waveform.zoomInTitle': 'Zoom in',
    'waveform.zoomResetTitle': 'Reset zoom',
    'waveform.status': 'In: {in} | Out: {out} | Dur: {dur}',
    'waveform.selectVideo': 'Select a video',
    'waveform.loading': 'Loading waveform...',
    'waveform.noAudioTrack': 'No audio track',

    'session.modalTitle': 'Start a new session',
    'session.modalHint': 'What do you want to do with the current PADS?',
    'session.startFresh': 'Start fresh',
    'session.orCopyFrom': 'or copy from',
    'session.selectSession': 'Select a session...',
    'session.copySessionOption': '{name} ({count} PADS)',
    'session.confirmOverwrite': 'A session named "{name}" already exists. Overwrite it with the imported one?',

    'error.zipUnsupportedBrowser': 'This browser does not support reading zip files (missing DecompressionStream)',
    'error.zipInvalidEocd': 'Not a valid zip file (end of central directory not found)',
    'error.zipMalformedCentralDir': 'Malformed zip central directory',
    'error.zipMalformedLocalHeader': 'Malformed zip local file header',
    'error.zipUnsupportedCompression': 'Unsupported zip compression method: {method}',
    'error.zipEntryNotFound': '"{entry}" not found inside the zip file',
  },
  es: {
    'common.pressKey': 'Presiona una tecla...',
    'common.remove': 'Eliminar',
    'common.copy': 'Copiar',
    'common.cancel': 'Cancelar',

    'header.stopAllTitle': 'Detener todo',
    'header.stopKeyCaptureTitle': 'Clic para configurar la tecla de stop',
    'header.sessionNamePlaceholder': 'nombre de la sesión',
    'header.save': 'Guardar',
    'header.loadSessionOption': 'Cargar sesión...',
    'header.new': 'Nueva',
    'header.export': 'Exportar',
    'header.exportTitle': 'Exportar sesión como ZIP',
    'header.import': 'Importar',
    'header.importTitle': 'Importar sesión desde ZIP',
    'header.localeSelectTitle': 'Idioma',

    'master.volume': 'Volumen',
    'master.cutoff': 'Corte',
    'master.resonance': 'Res',
    'master.reverb': 'Reverb',
    'master.delayTime': 'D.Time',
    'master.delayFeedback': 'D.FB',
    'tip.volume': 'Nivel general de volumen de salida.',
    'tip.cutoff': 'Frecuencia de corte del filtro pasa-bajos. Valores más bajos suenan más oscuros/apagados.',
    'tip.resonance': 'Realza las frecuencias cercanas al corte del filtro.',
    'tip.reverb': 'Agrega espacio/ambiente al sonido. 0% es totalmente seco.',
    'tip.delayTime': 'Tiempo en milisegundos entre cada repetición del eco.',
    'tip.delayFeedback': 'Cuántas veces se repite el eco antes de desvanecerse.',
    'tip.gridSize': 'Achicar la grilla descarta los PADs que ya no entran.',
    'tip.stopKeyCapture': 'Haz clic y luego presiona una tecla para asignarla como atajo global de stop.',
    'tip.addVideo': 'Solo se admiten links de YouTube. La descarga se hace en segundo plano.',
    'tip.triggerMode': 'One-shot reproduce la muestra completa una vez por cada toque. Gate reproduce solo mientras se mantiene apretada la tecla.',
    'tip.waveformHelp': 'Ctrl + Rueda = zoom\nArrastrar área vacía = desplazar\nI = Marcar entrada\nO = Marcar salida\nEspacio = Reproducir / Pausar\nArrastrar controles = ajustar inicio / fin\nClic en la onda = saltar',

    'video.placeholder': 'Agrega un video y asígnalo a un PAD',
    'video.urlPlaceholder': 'https://youtube.com/watch?v=...',
    'video.addButton': 'Agregar video',
    'video.status.ready': 'Listo',
    'video.status.downloading': 'Descargando',
    'video.status.queued': 'En cola',
    'video.status.error': 'Error',

    'panel.padEditorTitle': 'PAD Editor',
    'panel.videoLibraryTitle': 'Biblioteca de videos',
    'panel.collapseTitle': 'Contraer panel',
    'panel.expandTitle': 'Expandir panel',
    'library.toggleTitle': 'Mostrar/ocultar biblioteca de videos',
    'library.toggleLabel': 'Videos',

    'toast.stopKeySet': 'Tecla de stop configurada a {key}',
    'toast.allStopped': 'Todo detenido',
    'toast.padsResized': 'PADS redimensionados a {n}',
    'toast.videoNotLoaded': 'Video no cargado',
    'toast.audioLoadFailed': 'Error al cargar el audio: {message}',
    'toast.previewLoadFailed': 'Error al cargar el video de previsualización',
    'toast.previewPlayFailed': 'Error al reproducir la previsualización',
    'toast.assignKeyFirst': 'Asigna una tecla primero',
    'toast.selectVideoFirst': 'Selecciona un video primero',
    'toast.endAfterStart': 'El fin debe ser posterior al inicio',
    'toast.padUpdated': 'PAD {position} actualizado',
    'toast.videosLoadFailed': 'Error al cargar los videos: {message}',
    'toast.videoRemoved': 'Se eliminó {name}',
    'toast.removeFailed': 'Error al eliminar: {message}',
    'toast.videoAlreadyAvailable': 'El video ya está disponible',
    'toast.videoQueued': 'Video en cola de descarga',
    'toast.addFailed': 'Error al agregar: {message}',
    'toast.saveOrLoadBeforeExport': 'Guarda o carga una sesión antes de exportar',
    'toast.appReady': 'PumaSamplerMusic listo',
    'toast.enterSessionName': 'Ingresa un nombre de sesión',
    'toast.sessionSaved': 'Sesión "{name}" guardada',
    'toast.sessionSaveFailed': 'Error al guardar: {message}',
    'toast.sessionLoaded': 'Sesión "{name}" cargada',
    'toast.sessionLoadFailed': 'Error al cargar: {message}',
    'toast.sessionImported': 'Sesión "{name}" importada',
    'toast.sessionImportFailed': 'Error al importar: {message}',
    'toast.sessionImportVideosFailed': '{count} video(s) de la sesión importada no se encontraron en YouTube',
    'toast.selectSessionToCopy': 'Selecciona una sesión para copiar',
    'toast.sessionCopied': 'Sesión copiada. Ingresa un nombre nuevo y guarda.',
    'toast.importSelectZip': 'Selecciona un archivo ZIP de sesión para importar',

    'editor.clickPadToEdit': 'Haz clic en un PAD para editarlo',
    'editor.labelField': 'Etiqueta',
    'editor.labelPlaceholder': 'Kick, Bajo, etc.',
    'editor.keyField': 'Tecla',
    'editor.clickPressKey': 'Haz clic y presiona una tecla',
    'editor.keyValue': 'Tecla: {key}',
    'editor.videoField': 'Video',
    'editor.selectVideo': 'Selecciona un video...',
    'editor.previewField': 'Previsualización',
    'editor.transportField': 'Transporte',
    'editor.playTitle': 'Reproducir previsualización (Espacio)',
    'editor.pauseTitle': 'Pausar previsualización (Espacio)',
    'editor.stopTitle': 'Detener previsualización',
    'editor.setInTitle': 'Marcar el punto de entrada en la posición actual',
    'editor.setOutTitle': 'Marcar el punto de salida en la posición actual',
    'editor.setIn': 'Marcar entrada [I]',
    'editor.setOut': 'Marcar salida [O]',
    'editor.startField': 'Inicio',
    'editor.endField': 'Fin',
    'editor.previewVolumeField': 'Volumen de previsualización',
    'editor.padVolumeField': 'Volumen del PAD',
    'editor.triggerModeField': 'Modo de disparo',
    'editor.oneshotOption': 'One-shot (un toque)',
    'editor.gateOption': 'Gate (mientras se mantiene)',
    'editor.colorField': 'Color',
    'editor.loopField': 'Loop',
    'editor.applyButton': 'Aplicar al PAD',

    'waveform.label': 'Forma de onda',
    'waveform.zoomOutTitle': 'Alejar',
    'waveform.zoomInTitle': 'Acercar',
    'waveform.zoomResetTitle': 'Restablecer zoom',
    'waveform.status': 'In: {in} | Out: {out} | Dur: {dur}',
    'waveform.selectVideo': 'Selecciona un video',
    'waveform.loading': 'Cargando forma de onda...',
    'waveform.noAudioTrack': 'Sin pista de audio',

    'session.modalTitle': 'Iniciar una nueva sesión',
    'session.modalHint': '¿Qué deseas hacer con los PADS actuales?',
    'session.startFresh': 'Empezar de cero',
    'session.orCopyFrom': 'o copiar de',
    'session.selectSession': 'Selecciona una sesión...',
    'session.copySessionOption': '{name} ({count} PADS)',
    'session.confirmOverwrite': 'Ya existe una sesión llamada "{name}". ¿Deseas sobrescribirla con la importada?',

    'error.zipUnsupportedBrowser': 'Este navegador no admite la lectura de archivos zip (falta DecompressionStream)',
    'error.zipInvalidEocd': 'No es un archivo zip válido (no se encontró el final del directorio central)',
    'error.zipMalformedCentralDir': 'Directorio central del zip mal formado',
    'error.zipMalformedLocalHeader': 'Encabezado local del zip mal formado',
    'error.zipUnsupportedCompression': 'Método de compresión zip no soportado: {method}',
    'error.zipEntryNotFound': '"{entry}" no se encontró dentro del archivo zip',
  },
};

let current = localStorage.getItem(STORAGE_KEY) || 'en';
if (!dictionaries[current]) current = 'en';

export function getLocale() {
  return current;
}

export function setLocale(locale) {
  if (!dictionaries[locale]) return;
  current = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

export function t(key, vars) {
  const table = dictionaries[current] || dictionaries.en;
  let str = table[key] ?? dictionaries.en[key];
  if (str == null) {
    console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (vars) {
    for (const k in vars) {
      str = str.replaceAll(`{${k}}`, vars[k]);
    }
  }
  return str;
}

export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-tooltip]').forEach((el) => {
    el.dataset.tooltip = t(el.dataset.i18nTooltip);
  });
}
