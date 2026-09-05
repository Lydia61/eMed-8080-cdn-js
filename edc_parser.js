let parserDependencies = null;
let parserWorkerUrl = "";

export function configureEdcParser(dependencies) {
  parserDependencies = dependencies;
}

function getParserWorkerUrl() {
  if (!parserWorkerUrl) parserWorkerUrl = new URL("./parser.worker.js", import.meta.url);
  return parserWorkerUrl;
}

function readFileBuffer(file, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

function runParserTask(message, transfer = [], onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(getParserWorkerUrl());
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === "progress") {
        onProgress({ percent: data.percent, message: data.message });
        return;
      }
      if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.error));
        return;
      }
      if (data.type === "result") {
        worker.terminate();
        resolve(data);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error || new Error("Worker 解析失败"));
    };
    worker.postMessage(message, transfer);
  });
}

export async function classifyFile(file, onProgress = () => {}) {
  const buffer = await readFileBuffer(file, (loaded, total) => {
    const ratio = total > 0 ? loaded / total : 0;
    onProgress({ percent: Math.round(ratio * 10), message: `正在读取 ${file.name} ${Math.round(ratio * 100)}%...` });
  });
  const result = await runParserTask(
    { type: "classify", buffer, fileName: file.name },
    [buffer],
    onProgress,
  );
  return result.isCoding;
}

export async function parseAeCodingFile(file, onProgress = () => {}) {
  const buffer = await readFileBuffer(file);
  const result = await runParserTask(
    { type: "ae-coding", buffer, fileName: file.name },
    [buffer],
    onProgress,
  );
  return new Map(result.entries);
}

export async function parseLabAeFiles(mappingFile, ctcFile, onProgress = () => {}) {
  const [mappingBuffer, ctcBuffer] = await Promise.all([
    readFileBuffer(mappingFile),
    readFileBuffer(ctcFile),
  ]);
  const result = await runParserTask(
    {
      type: "lab-ae",
      files: [
        { buffer: mappingBuffer, fileName: mappingFile.name },
        { buffer: ctcBuffer, fileName: ctcFile.name },
      ],
    },
    [mappingBuffer, ctcBuffer],
    onProgress,
  );
  return result.data;
}

export async function parseEdcWorkbook(file, onProgress = () => {}) {
  if (!parserDependencies) {
    throw new Error("EDC 解析器尚未完成配置。");
  }
  const buffer = await readFileBuffer(file, (loaded, total) => {
    const safeTotal = total > 0 ? total : loaded;
    const ratio = safeTotal > 0 ? loaded / safeTotal : 0;
    const percent = Math.max(4, Math.min(18, Math.round(4 + ratio * 14)));
    onProgress({ percent, message: `正在读取文件 ${Math.round(ratio * 100)}%...` });
  });
  onProgress({ percent: 20, message: "文件读取完成，准备解析工作表..." });
  const result = await runParserTask(
    { type: "edc", buffer, fileName: file.name, edcParserSource: parserDependencies.createWorkerSource() },
    [buffer],
    onProgress,
  );
  const patientMap = new Map();
  result.patients.forEach((patient) => {
    parserDependencies.finalizePatient(patient);
    patientMap.set(patient.patientId, patient);
  });
  onProgress({ percent: 99, message: `正在完成患者视图整理（${result.patients.length} 人）...` });
  return patientMap;
}
