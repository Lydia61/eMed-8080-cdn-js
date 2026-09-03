let parserWorkerUrl = "";
let parserDependencies = null;

export function configureEdcParser(dependencies) {
  parserDependencies = dependencies;
}

export async function parseEdcWorkbook(file, onProgress = () => {}) {
  if (!parserDependencies) {
    throw new Error("EDC 解析器尚未完成配置。");
  }

  if (!parserWorkerUrl) {
    parserWorkerUrl = URL.createObjectURL(
      new Blob([parserDependencies.createWorkerSource()], { type: "text/javascript" })
    );
  }

  const buffer = await parserDependencies.readFileBuffer(file, (loaded, total) => {
    const safeTotal = total > 0 ? total : loaded;
    const ratio = safeTotal > 0 ? loaded / safeTotal : 0;
    const percent = Math.max(4, Math.min(18, Math.round(4 + ratio * 14)));
    onProgress({ percent, message: `正在读取文件 ${Math.round(ratio * 100)}%...` });
  });
  onProgress({ percent: 20, message: "文件读取完成，准备解析工作表..." });

  return new Promise((resolve, reject) => {
    const worker = new Worker(parserWorkerUrl);

    worker.onmessage = (event) => {
      const { type, message, patients, error, percent } = event.data;
      if (type === "progress") {
        onProgress({ percent, message });
        return;
      }
      if (type === "error") {
        worker.terminate();
        reject(new Error(error));
        return;
      }
      if (type === "result") {
        const patientMap = new Map();
        patients.forEach((patient) => {
          parserDependencies.finalizePatient(patient);
          patientMap.set(patient.patientId, patient);
        });
        onProgress({ percent: 99, message: `正在完成患者视图整理（${patients.length} 人）...` });
        worker.terminate();
        resolve(patientMap);
      }
    };

    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error || new Error("Worker 解析失败"));
    };

    worker.postMessage({ buffer, fileName: file.name }, [buffer]);
  });
}
