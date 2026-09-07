importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");

const MAPPING_FIELDS = ["EDC Labtest", "HRSTD LBTEST-EN", "HRSTD LBTEST-CN"];
const LIBRARY_FIELDS = ["HRSTD LBTEST-EN", "HRSTD LBTEST-CN", "编码描述-CN", "检查PT"];
const CTC_FIELDS = ["VERSION", "LBTOXCN", "LBTESTCD", "LBTEST_EN", "LBTEST_CN", "LBTOXDIR", "LBSTRESU", "GRADE1", "GRADE2", "GRADE3", "GRADE4"];

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalize(value) {
  return text(value)
    .toLowerCase()
    .replace(/gamma[-\s]*glutamyl[-\s]*transferase|γ[-\s]*谷氨酰基?转移酶?|伽马[-\s]*谷氨酰基?转移酶?|谷氨酰基转移酶|谷氨酰转移酶|ggt/g, "谷氨酰转移酶")
    .replace(/[\s_\-/()[\]{}、，,;；:：]+/g, "");
}

function findSheet(workbook, names) {
  const wanted = names.map(normalize);
  return workbook.SheetNames.find((name) => {
    const current = normalize(name);
    return wanted.some((candidate) => current === candidate || current.includes(candidate));
  }) || "";
}

function readRows(workbook, sheetName, fields) {
  if (!sheetName) return [];
  const rows = self.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
  return rows.map((row) => {
    const output = {};
    fields.forEach((field) => {
      const key = Object.keys(row).find((candidate) => normalize(candidate) === normalize(field));
      output[field] = key ? text(row[key]) : "";
    });
    return output;
  }).filter((row) => Object.values(row).some(Boolean));
}

function parseMappingWorkbook(workbook, fileName) {
  const mappingSheet = findSheet(workbook, ["mapping关系与检查项一致性核查", "mapping关系", "mapping"]);
  const librarySheet = findSheet(workbook, ["Mapping关系库", "mapping关系库"]);
  const mapping = readRows(workbook, mappingSheet, MAPPING_FIELDS);
  const mappingLibrary = readRows(workbook, librarySheet, LIBRARY_FIELDS);
  const libraryKeys = new Set(mappingLibrary.map((row) =>
    `${normalize(row["HRSTD LBTEST-EN"])}|${normalize(row["HRSTD LBTEST-CN"])}`
  ));
  const consistency = mapping.map((row) => ({
    ...row,
    consistency: libraryKeys.has(`${normalize(row["HRSTD LBTEST-EN"])}|${normalize(row["HRSTD LBTEST-CN"])}`)
      ? "一致"
      : "未找到对应检查项",
  }));
  return { fileName, mappingSheet, librarySheet, mapping, mappingLibrary, consistency };
}

function parseCtcWorkbook(workbook, fileName) {
  const sheetName = findSheet(workbook, ["Criteria"]) || workbook.SheetNames[0] || "";
  return { fileName, sheetName, grades: readRows(workbook, sheetName, CTC_FIELDS) };
}

function parseAeCodingWorkbook(workbook) {
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = self.XLSX.utils.sheet_to_json(firstSheet, { defval: "", raw: false });
  return rows.flatMap((row) => {
    const subjectCode = text(row["Subject Code"]);
    const sequence = text(row.Sn);
    if (!subjectCode || !sequence) return [];
    return [[`${subjectCode}|${sequence}`, {
      lltCn: text(row.LLT_CN),
      ptCn: text(row.PT_CN),
      ptCode: text(row["PT Code"]),
      socCn: text(row.SOC_CN),
    }]];
  });
}

function isAeCodingWorkbook(workbook) {
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = self.XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: "", raw: false });
  const headers = new Set((rows[0] || []).map((value) => text(value).toLowerCase()));
  return headers.has("subject code") && headers.has("sn");
}

function readWorkbook(buffer) {
  return self.XLSX.read(buffer, {
    type: "array",
    cellDates: false,
    dense: true,
    cellNF: false,
    cellHTML: false,
    cellStyles: false,
  });
}

function sendProgress(percent, message) {
  self.postMessage({ type: "progress", percent, message });
}

function parseFile(buffer, fileName, percentStart, percentEnd) {
  sendProgress(percentStart, `正在解析 ${fileName}...`);
  const workbook = readWorkbook(buffer);
  sendProgress(percentEnd, `已完成解析 ${fileName}`);
  return workbook;
}

self.onmessage = (event) => {
  const { type, files, buffer, fileName, edcParserSource } = event.data;
  try {
    if (type === "classify") {
      const workbook = parseFile(buffer, fileName, 10, 35);
      self.postMessage({ type: "result", task: type, isCoding: isAeCodingWorkbook(workbook) });
      return;
    }

    if (type === "ae-coding") {
      const workbook = parseFile(buffer, fileName, 20, 75);
      self.postMessage({ type: "result", task: type, entries: parseAeCodingWorkbook(workbook) });
      return;
    }

    if (type === "lab-ae") {
      const mappingWorkbook = parseFile(files[0].buffer, files[0].fileName, 10, 45);
      const ctcWorkbook = parseFile(files[1].buffer, files[1].fileName, 48, 82);
      self.postMessage({
        type: "result",
        task: type,
        data: {
          mapping: parseMappingWorkbook(mappingWorkbook, files[0].fileName),
          ctc: parseCtcWorkbook(ctcWorkbook, files[1].fileName),
        },
      });
      return;
    }

    if (type === "edc") {
      // The existing EDC field rules are supplied by the application and run here.
      // The worker owns XLSX.read and the resulting patient objects never block the UI.
      (0, eval)(edcParserSource);
      self.onmessage({ data: { buffer, fileName } });
      return;
    }

    throw new Error(`未知解析任务：${type}`);
  } catch (error) {
    self.postMessage({ type: "error", error: error?.message || String(error) });
  }
};
