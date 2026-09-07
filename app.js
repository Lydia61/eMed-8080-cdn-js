// HRS-8080-305 数据整理工具 V0.1
// 基于 A1811-312 实验室数据整理工具 V0.4 改造
// 主要变更：Sheet 识别改为中文名称，字段映射全部改为中文 EDC 字段

import {
  classifyFile,
  configureEdcParser,
  parseAeCodingFile,
  parseEdcWorkbook,
  parseLabAeFiles,
} from "./edc_parser.js";
import { deriveLabAe, getReadOnlyLabAeApi } from "./medical_engine_labae.js?v=20260902-9";

const state = {
  workbookName: "",
  aeCodingName: "",
  aeCoding: new Map(),
  patients: new Map(),
  patientIds: [],
  filteredIds: [],
  centerOptions: [],
  selectedCenter: "ALL",
  selectedPatientId: "",
  labAeData: null,
  blindMode: true,
};

// 305 基线字段（9项）
const baselineFields = [
  { key: "grade",      label: "首次组织学分级" },
  { key: "cTnm",       label: "cTNM分期" },
  { key: "pathGrade",  label: "术后分级" },
  { key: "pTnm",       label: "pTNM分期" },
  { key: "tumorSize",  label: "肿瘤直径" },
  { key: "lymphCount", label: "淋巴结(枚)" },
  { key: "er",         label: "ER" },
  { key: "pr",         label: "PR" },
  { key: "her2",       label: "HER2" },
];

// 305 患者编号格式：CN + 中心3位 + 受试者3位，如 CN001002
const patientIdPattern = /CN\d{5,7}/i;

const elements = {};
let uploadProgressHideTimer = 0;
let aePopupWindow = null;

function initializeApplication() {
  bindElements();
  bindEvents();
  renderBlindModeToggle();
  renderAll();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApplication, { once: true });
} else {
  initializeApplication();
}

function bindElements() {
  elements.fileInput                    = document.getElementById("excelFile");
  elements.workbookName                 = document.getElementById("workbookName");
  elements.uploadProgress               = document.getElementById("uploadProgress");
  elements.uploadProgressBar            = document.getElementById("uploadProgressBar");
  elements.uploadProgressText           = document.getElementById("uploadProgressText");
  elements.patientSearch                = document.getElementById("patientSearch");
  elements.centerSelect                 = document.getElementById("centerSelect");
  elements.patientSelect                = document.getElementById("patientSelect");
  elements.patientList                  = document.getElementById("patientList");
  elements.patientCountBadge            = document.getElementById("patientCountBadge");
  elements.selectedPatientTitle         = document.getElementById("selectedPatientTitle");
  elements.selectedPatientSubtitle      = document.getElementById("selectedPatientSubtitle");
  elements.selectedPatientStratification= document.getElementById("selectedPatientStratification");
  elements.heroHintContent              = document.getElementById("heroHintContent");
  elements.baselineGrid                 = document.getElementById("baselineGrid");
  elements.questionPanel                = document.getElementById("questionPanel");
  elements.historyList                  = document.getElementById("historyList");
  elements.systemicList                 = document.getElementById("systemicList");
  elements.responseList                 = document.getElementById("responseList");
  elements.labsGrid                     = document.getElementById("labsGrid");
  elements.labCountBadge                = document.getElementById("labCountBadge");
  elements.aeActionBar                  = document.getElementById("aeActionBar");
  elements.cmActionBar                  = document.getElementById("cmActionBar");
  elements.labAeActionBar               = document.getElementById("labAeActionBar");
  elements.uploadDropzone               = document.querySelector(".upload-dropzone");
  elements.labAeMappingInput            = document.getElementById("labAeMappingFile");
  elements.labAeCtcInput                = document.getElementById("labAeCtcFile");
  elements.labAeProgress                = document.getElementById("labAeProgress");
  elements.labAeProgressBar             = document.getElementById("labAeProgressBar");
  elements.labAeProgressText            = document.getElementById("labAeProgressText");
  elements.labAeStatus                 = document.getElementById("labAeStatus");
  elements.blindModeToggle             = document.getElementById("blindModeToggle");
  elements.blindModeLabel              = document.getElementById("blindModeLabel");
}

function bindEvents() {
  elements.fileInput.addEventListener("change", handleFileSelection);
  elements.blindModeToggle.addEventListener("click", () => {
    state.blindMode = !state.blindMode;
    renderBlindModeToggle();
    const selectedPatient = state.patients.get(state.selectedPatientId);
    if (aePopupWindow && !aePopupWindow.closed && selectedPatient) {
      aePopupWindow.close();
      openAeWindow(selectedPatient);
    }
  });
  elements.labAeMappingInput.addEventListener("change", handleLabAeFileSelection);
  elements.labAeCtcInput.addEventListener("change", handleLabAeFileSelection);
  elements.patientSearch.addEventListener("input", renderPatientControls);
  elements.centerSelect.addEventListener("change", (event) => {
    state.selectedCenter = event.target.value;
    renderPatientControls();
    renderPatientView();
  });
  elements.patientSelect.addEventListener("change", (event) => {
    setSelectedPatient(event.target.value);
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.uploadDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.uploadDropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.uploadDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.uploadDropzone.classList.remove("dragover");
    });
  });

  elements.uploadDropzone.addEventListener("drop", (event) => {
    handleFileSelection({ target: { files: event.dataTransfer.files || [] } });
  });
}

function renderBlindModeToggle() {
  elements.blindModeLabel.hidden = !state.blindMode;
  elements.blindModeToggle.setAttribute("aria-pressed", String(!state.blindMode));
  elements.blindModeToggle.title = state.blindMode ? "切换到真实字段模式" : "切换到盲态模式";
}

async function handleLabAeFileSelection() {
  const mappingFile = elements.labAeMappingInput.files[0];
  const ctcFile = elements.labAeCtcInput.files[0];
  if (!mappingFile || !ctcFile) {
    elements.labAeStatus.textContent = "请同时选择 Mapping关系文件和 lab-ctc-grade 文件。";
    return;
  }
  try {
    elements.labAeStatus.textContent = "正在解析 Lab-AE 文件...";
    state.labAeData = await parseLabAeFiles(mappingFile, ctcFile, ({ percent, message }) => {
      showLabAeProgress(percent, message);
    });
    if (state.patients.size) {
      deriveLabAe(state.patients, state.labAeData);
      renderAll();
    }
    showLabAeProgress(100, "Lab-AE 解析完成");
    elements.labAeStatus.textContent = `已解析：Mapping ${state.labAeData.mapping.mapping.length} 行，检查项库 ${state.labAeData.mapping.mappingLibrary.length} 行，CTC ${state.labAeData.ctc.grades.length} 行。`;
    window.dispatchEvent(new CustomEvent("lab-ae-data-ready", { detail: { data: state.labAeData, patients: state.patients } }));
  } catch (error) {
    console.error(error);
    showLabAeProgress(100, "Lab-AE 读取失败");
    elements.labAeStatus.textContent = "Lab-AE 文件解析失败，请检查工作表名称和字段。";
  }
}

async function handleFileSelection(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  state.blindMode = true;
  renderBlindModeToggle();
  showUploadProgress(1, `已选择 ${files.length} 个文件，正在识别文件类型...`);
  elements.workbookName.textContent = "正在识别上传文件...";

  try {
    const classified = await Promise.all(files.map(async (file, index) => ({
      file,
      isCoding: await classifyFile(file, ({ percent, message }) => {
        const fileShare = 16 / files.length;
        const overallPercent = 1 + ((index + percent / 100) * fileShare);
        showUploadProgress(overallPercent, message);
      }),
    })));
    const edcFile = classified.find((entry) => !entry.isCoding)?.file;
    const codingFiles = classified.filter((entry) => entry.isCoding).map((entry) => entry.file);

    if (codingFiles.length) {
      const codingMaps = await Promise.all(codingFiles.map(parseAeCodingFile));
      state.aeCoding = new Map(codingMaps.flatMap((codingMap) => codingMap.entries()));
      state.aeCodingName = codingFiles.map((file) => file.name).join("、");
      if (state.patients.size) {
        applyAeCoding(state.patients);
        renderAll();
      }
    }
    if (edcFile) await parseWorkbook(edcFile);
    else if (codingFiles.length) {
      elements.workbookName.textContent = `已读取 AE 编码文件：${state.aeCodingName}，请继续选择 EDC 文件。`;
    }
  } catch (error) {
    console.error(error);
    elements.workbookName.textContent = "文件读取失败，请确认文件格式和内容。";
    showUploadProgress(100, `读取失败：${error.message || "未知错误"}`);
  }
}

function applyAeCoding(patients) {
  patients.forEach((patient) => {
    patient.aeList.forEach((ae) => {
      const coding = state.aeCoding.get(`${patient.patientId}|${String(ae.seqNum).trim()}`);
      ae.lltCn = coding?.lltCn || "";
      ae.ptCn = coding?.ptCn || "";
      ae.ptCode = coding?.ptCode || "";
      ae.socCn = coding?.socCn || "";
    });
  });
}

async function parseWorkbook(file) {
  try {
    showUploadProgress(4, "准备读取文件...");
    elements.workbookName.textContent = "正在载入 EDC 数据...";
    const patients = await parseEdcWorkbook(file, ({ percent, message }) => {
      showUploadProgress(percent, message);
    });
    state.workbookName = file.name;
    state.patients = patients;
    applyAeCoding(patients);
    state.patientIds = Array.from(patients.keys()).sort();
    state.centerOptions = collectCenterOptions(patients);
    state.selectedCenter = "ALL";
    state.filteredIds = [...state.patientIds];
    state.selectedPatientId = state.patientIds[0] || "";
    if (state.labAeData) deriveLabAe(state.patients, state.labAeData);
    renderAll();
    window.dispatchEvent(new CustomEvent("edc-data-ready", {
      detail: {
        patients: state.patients,
        patientIds: [...state.patientIds],
        workbookName: state.workbookName,
        selectedPatientId: state.selectedPatientId,
      },
    }));
    showUploadProgress(100, "解析完成");
    scheduleHideUploadProgress();
  } catch (error) {
    console.error(error);
    clearUploadProgressHideTimer();
    showUploadProgress(100, "读取失败，请检查文件格式");
    elements.workbookName.textContent = "Excel 读取失败，请确认文件格式和工作表内容。";
  }
}

function showUploadProgress(percent, message) {
  clearUploadProgressHideTimer();
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements.uploadProgress.hidden = false;
  elements.uploadProgressBar.style.width = `${safePercent}%`;
  elements.uploadProgressText.textContent = `${safePercent}% · ${message}`;
}

function showLabAeProgress(percent, message) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements.labAeProgress.hidden = false;
  elements.labAeProgressBar.style.width = `${safePercent}%`;
  elements.labAeProgressText.textContent = `${safePercent}% · ${message}`;
}

function clearUploadProgressHideTimer() {
  if (uploadProgressHideTimer) {
    window.clearTimeout(uploadProgressHideTimer);
    uploadProgressHideTimer = 0;
  }
}

function scheduleHideUploadProgress() {
  clearUploadProgressHideTimer();
  uploadProgressHideTimer = window.setTimeout(() => {
    elements.uploadProgress.hidden = true;
    elements.uploadProgressBar.style.width = "0%";
    elements.uploadProgressText.textContent = "准备读取文件...";
    uploadProgressHideTimer = 0;
  }, 900);
}

function formatWorkbookNote(fileName) {
  const cutoffDate = extractCutoffDate(fileName);
  if (cutoffDate) return `数据 cut off：${cutoffDate}`;
  return fileName || "尚未载入文件";
}

function extractCutoffDate(fileName) {
  const text = String(fileName || "");
  const matches = Array.from(
    text.matchAll(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[-_]?([0-2]\d))?(?:[-_]?([0-5]\d))?/g)
  );
  if (!matches.length) return "";
  const lastMatch = matches[matches.length - 1];
  return `${lastMatch[1]}${lastMatch[2]}${lastMatch[3]}`;
}

// ═══════════════════════════════════════════════════════
// WEB WORKER — 完整解析逻辑（字符串形式，在 Worker 内执行）
// ═══════════════════════════════════════════════════════
function createParserWorkerSource() {
  return `
    importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

    // 305 患者编号格式 CN + 5~7位数字
    const patientIdPattern = /CN\\d{5,7}/i;

    function stringify(value) {
      if (value === null || value === undefined) return '';
      return String(value).trim();
    }

    function normalizeKey(value) {
      return stringify(value)
        .toLowerCase()
        .replace(/[\\s_\\-\\/()\\[\\]{}]+/g, '')
        .replace(/[^a-z0-9\\u4e00-\\u9fa5]/g, '');
    }

    function matchesPattern(normKey, pattern) {
      if (pattern instanceof RegExp) return pattern.test(normKey);
      return normKey.includes(normalizeKey(pattern));
    }

    function pickValue(accessor, patterns) {
      for (const pattern of patterns) {
        const exactMatch = accessor.entries.find((entry) => matchesPattern(entry.normKey, pattern));
        if (exactMatch && exactMatch.value) return exactMatch.value;
      }
      return '';
    }

    function pickLastValue(accessor, patterns) {
      for (const pattern of patterns) {
        const matches = accessor.entries.filter((entry) => matchesPattern(entry.normKey, pattern) && entry.value);
        if (matches.length) return matches[matches.length - 1].value;
      }
      return '';
    }

    function createAccessor(row) {
      const entries = Object.entries(row)
        .map(([key, value]) => ({ key, normKey: normalizeKey(key), value: stringify(value) }))
        .filter((entry) => entry.value !== '');
      return { entries };
    }

    // ── 305 Sheet 名称识别（中文 + 括号内英文代码）──
    function detectSheetContext(sheetName) {
      const normalized = normalizeKey(sheetName);

      // 参与者信息(subject)
      if (normalized.includes('参与者信息')) return 'subjectInformation';
      // 随机(dsrand) — 用代码精确匹配避免误判
      if (normalized.includes('dsrand')) return 'randomization';
      // 分层因素(dsrsf)
      if (normalized.includes('分层因素')) return 'stratificationFactor';
      // 肿瘤诊断(乳腺癌)(mhcbc)
      if (normalized.includes('mhcbc')) return 'tumorBreast';
      // 肿瘤诊断(病理)(mipbc)
      if (normalized.includes('mipbc')) return 'tumorPathology';
      // 访视日期(sv)
      if (normalized.includes('访视日期')) return 'visitDate';
      // 既往病史(mh)
      if (normalized.includes('既往病史')) return 'medicalHistory';
      // 不良事件(ae)
      if (normalized.includes('不良事件')) return 'adverseEvent';
      // 体重(vswt) — 精确匹配避免与生命体征混淆
      if (normalized === 'vswt' || normalized.includes('vswt')) return 'weight';
      // 实验室检查(lb) — 主要血液学检查表
      if (normalized === 'lb' || normalized.includes('实验室检查')) return 'laboratory';
      // 肿瘤影像学(tu) — V0.1 暂存为 responseAssessment，字段待完善
      if (normalized.includes('肿瘤影像学')) return 'responseAssessment';
      // 系统性抗肿瘤治疗史
      if (normalized.includes('系统性抗肿瘤治疗史')) return 'systemicTreatment';
      // 既往及合并用药(cm)
      if (normalized.includes('既往及合并用药')) return 'concomitantMed';
      // 给药记录
      if (normalized.includes('hrs8080') && normalized.includes('给药')) return 'hrs8080Admin';
      if (normalized.includes('来曲唑') && normalized.includes('给药')) return 'letrozoleAdmin';
      if (normalized.includes('他莫昔芬') && normalized.includes('给药')) return 'tamoxifenAdmin';
      if (normalized.includes('阿那曲唑') && normalized.includes('给药')) return 'anastrozoleAdmin';
      if (normalized.includes('依西美坦') && normalized.includes('给药')) return 'exemestaneAdmin';
      // dummy_sv 来源页面
      if (/(^|[^a-z])(dseos|ecog|eg|exo[a-z0-9]*|lb|pe|vs|vswt)([^a-z]|$)/.test(normalized)) return 'dummySv';

      return 'other';
    }

    function createEmptyPatient(patientId) {
      return {
        patientId,
        center: '',
        subjectStatus: '',
        currentVisit: '',
        currentVisitSort: Number.NEGATIVE_INFINITY,
        // 305 分层因素：绝经状态 / 癌症分期 / 淋巴结数 / CDK4/6治疗时长
        stratification: {
          menoStatus: '',
          cancerStage: '',
          lymphNodes: '',
          cdk46Duration: '',
        },
        rowCount: 0,
        baseline: {
          group: '',
          grade: '',        // 首次组织学分级
          pathGrade: '',    // 术后原发灶组织学分级
          cTnm: '',         // T2N2 IIIA（临床TNM + 临床分期）
          pTnm: '',         // T1N1 IIA（术后病理TNM + 术后病理分期）
          tumorSize: '',    // 术后病理原发灶肿瘤直径（含单位）
          lymphCount: '',   // 术后阳性腋窝淋巴结数量
          er: '',           // 80，阳性
          pr: '',           // 50，阳性
          her2: '',         // HER2(IHC)结果
          // 内部字段（备用）
          tStage: '', nStage: '', ajcc: '', mStage: '',
        },
        labs: [],
        svRows: [],
        groupedLabs: [],
        drugAdmins: [],
        histories: [],
        responses: [],
        cmList: [],
        aeList: [],
        aeActions: [],
        systemicList: [],
        criticalHints: [],
        questions: [],
        abnormalCount: 0,
      };
    }

    // ── 305 随机组别标准化 ──
    function normalizeGroup(value) {
      const normalized = value.toLowerCase();
      if (normalized.includes('hrs') || normalized.includes('联合') || normalized.includes('试验')) return '试验组';
      if (normalized.includes('标准') || normalized.includes('对照') || normalized.includes('control')) return '对照组';
      return value;
    }

    function formatDate(value) {
      if (!value) return '未提供';
      if (typeof value === 'number' && self.XLSX && self.XLSX.SSF) {
        const parsed = self.XLSX.SSF.parse_date_code(value);
        if (parsed) {
          const date = new Date(parsed.y, parsed.m - 1, parsed.d);
          return new Intl.DateTimeFormat('zh-CN').format(date);
        }
      }
      const date = new Date(String(value).replace(/\\./g, '-').replace(/\\//g, '-'));
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat('zh-CN').format(date);
    }

    // 305 访视名称直接使用中文，仅做最小裁剪
    function formatVisitLabel(value) {
      const raw = stringify(value);
      if (!raw) return '';
      const normalized = raw.toLowerCase();
      if (normalized.includes('screening')) return '筛选期';
      if (normalized.includes('unscheduled')) return '计划外';
      return raw;
    }

    function toSortableDate(value) {
      if (!value) return Number.MAX_SAFE_INTEGER;
      if (typeof value === 'number' && self.XLSX && self.XLSX.SSF) {
        const parsed = self.XLSX.SSF.parse_date_code(value);
        if (parsed) return Date.UTC(parsed.y, parsed.m - 1, parsed.d);
      }
      const parsed = Date.parse(String(value).replace(/\\./g, '-').replace(/\\//g, '-'));
      return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
    }

    function parseNumeric(value) {
      if (!value) return Number.NaN;
      const match = String(value).replace(/,/g, '').match(/-?\\d+(\\.\\d+)?/);
      return match ? Number(match[0]) : Number.NaN;
    }

    function parseRangeText(rawRange) {
      if (!rawRange) return { low: Number.NaN, high: Number.NaN };
      const match = String(rawRange).replace(/,/g, '').match(/(-?\\d+(?:\\.\\d+)?)\\s*(?:-|~|to|—)\\s*(-?\\d+(?:\\.\\d+)?)/i);
      if (!match) return { low: Number.NaN, high: Number.NaN };
      return { low: Number(match[1]), high: Number(match[2]) };
    }

    function buildReferenceRange(lowValue, highValue, rawRange) {
      if (lowValue || highValue) return (lowValue || '?') + ' - ' + (highValue || '?');
      return rawRange || '未提供';
    }

    function detectAbnormality(result, lowValue, highValue, rawRange) {
      const resultNumber = parseNumeric(result);
      const lowNumber    = parseNumeric(lowValue);
      const highNumber   = parseNumeric(highValue);
      const rangeNumbers = parseRangeText(rawRange);
      const effectiveLow  = Number.isFinite(lowNumber)  ? lowNumber  : rangeNumbers.low;
      const effectiveHigh = Number.isFinite(highNumber) ? highNumber : rangeNumbers.high;
      if (!Number.isFinite(resultNumber)) return 'normal';
      if (Number.isFinite(effectiveHigh) && resultNumber > effectiveHigh) return 'high';
      if (Number.isFinite(effectiveLow)  && resultNumber < effectiveLow)  return 'low';
      return 'normal';
    }

    // ── 305 Sheet 合并函数 ──

    // 参与者信息(subject)
    function mergeSubjectInformation(patient, accessor) {
      const centerValue   = pickValue(accessor, ['中心编号', '中心名称', /centernumber/, /centerid/]);
      const subjectStatus = pickValue(accessor, ['参与者状态', /subjectstatus/, /participantstatus/]);
      if (centerValue && !patient.center)        patient.center        = centerValue;
      if (subjectStatus && !patient.subjectStatus) patient.subjectStatus = subjectStatus;
    }

    // 访视日期(sv)
    function mergeVisitDate(patient, accessor) {
      const visitValue = pickValue(accessor, ['访视名称', /^访视名称$/, /visitname/]);
      const visitDate  = pickValue(accessor, ['访视日期', /^访视日期$/, /visitdate/]);
      const sortableVisitDate = toSortableDate(visitDate);
      if (!visitValue || sortableVisitDate === Number.MAX_SAFE_INTEGER) return;
      if (sortableVisitDate >= patient.currentVisitSort) {
        patient.currentVisit     = formatVisitLabel(visitValue);
        patient.currentVisitSort = sortableVisitDate;
      }
    }

    function mergeDummySvRow(patient, accessor) {
      const visit = formatVisitLabel(pickValue(accessor, ['访视名称', /^访视名称$/, /visitname/]));
      const rawDate = pickValue(accessor, ['访视日期', /^访视日期$/, /visitdate/, '采样日期', /^采样日期$/, /collectiondate/, '检查日期', /^检查日期$/, /examdate/]);
      const sortableDate = toSortableDate(rawDate);
      if (visit && sortableDate !== Number.MAX_SAFE_INTEGER) patient.svRows.push({ visit, date: sortableDate });
    }

    // 随机(dsrand)
    function mergeRandomization(patient, accessor) {
      const groupValue = pickValue(accessor, ['组别', /^组别$/, /treatmentgroup/, /studyarm/, /arm/]);
      if (groupValue && !patient.baseline.group) patient.baseline.group = normalizeGroup(groupValue);
    }

    // 分层因素(dsrsf) — 305 特有四个分层维度
    function mergeStratificationFactor(patient, accessor) {
      const menoStatus   = pickValue(accessor, ['初诊时绝经状态', /绝经状态/, /绝经/]);
      const cancerStage  = pickValue(accessor, ['乳腺癌分期',     /乳腺癌分期/, /癌症分期/]);
      const lymphNodes   = pickValue(accessor, ['阳性腋窝淋巴结个数', /淋巴结个数/, /淋巴结/]);
      const cdk46Dur     = pickValue(accessor, ['CDK4/6抑制剂治疗时长', /cdk46/, /cdk4/]);
      if (menoStatus  && !patient.stratification.menoStatus)   patient.stratification.menoStatus   = menoStatus;
      if (cancerStage && !patient.stratification.cancerStage)  patient.stratification.cancerStage  = cancerStage;
      if (lymphNodes  && !patient.stratification.lymphNodes)   patient.stratification.lymphNodes   = lymphNodes;
      if (cdk46Dur    && !patient.stratification.cdk46Duration) patient.stratification.cdk46Duration = cdk46Dur;
    }

    // 肿瘤诊断(乳腺癌)(mhcbc)
    function mergeTumorBreast(patient, accessor) {
      const grade      = pickValue(accessor, ['首次组织学分级',           /^首次组织学分级$/]);
      const pathGrade  = pickValue(accessor, ['术后原发灶组织学分级',     /^术后原发灶组织学分级$/]);
      const tStage     = pickValue(accessor, ['临床TNM分期(T)',            /^临床tnm分期t$/]);
      const nStage     = pickValue(accessor, ['临床TNM分期(N)',            /^临床tnm分期n$/]);
      const ajcc       = pickValue(accessor, ['临床分期',                  /^临床分期$/]);
      const pathT      = pickValue(accessor, ['术后病理TNM分期(T)',        /^术后病理tnm分期t$/]);
      const pathN      = pickValue(accessor, ['术后病理TNM分期(N)',        /^术后病理tnm分期n$/]);
      const pathStage  = pickValue(accessor, ['术后病理分期',              /^术后病理分期$/]);
      const tumorDiam  = pickValue(accessor, ['术后病理原发灶肿瘤直径',    /^术后病理原发灶肿瘤直径$/]);
      const tumorUnit  = pickValue(accessor, ['术后病理原发灶肿瘤直径单位', /^术后病理原发灶肿瘤直径单位$/]);
      const lymphCnt   = pickValue(accessor, ['术后阳性腋窝淋巴结数量',   /^术后阳性腋窝淋巴结数量$/]);

      patient.baseline.grade     = patient.baseline.grade     || grade;
      patient.baseline.pathGrade = patient.baseline.pathGrade || pathGrade;
      patient.baseline.tStage    = patient.baseline.tStage    || tStage;
      patient.baseline.nStage    = patient.baseline.nStage    || nStage;
      patient.baseline.ajcc      = patient.baseline.ajcc      || ajcc;

      // cTNM: T2N2 IIIA
      if (!patient.baseline.cTnm) {
        const tnPart = [tStage, nStage].filter(Boolean).join('');
        if (tnPart || ajcc) patient.baseline.cTnm = [tnPart, ajcc].filter(Boolean).join(' ');
      }
      // pTNM: T1N1 IIA
      if (!patient.baseline.pTnm) {
        const pathTNPart = [pathT, pathN].filter(Boolean).join('');
        if (pathTNPart || pathStage) patient.baseline.pTnm = [pathTNPart, pathStage].filter(Boolean).join(' ');
      }
      // 肿瘤直径（含单位）
      if (!patient.baseline.tumorSize && tumorDiam) {
        patient.baseline.tumorSize = tumorUnit ? tumorDiam + tumorUnit : tumorDiam;
      }
      // 淋巴结数量
      patient.baseline.lymphCount = patient.baseline.lymphCount || lymphCnt;
    }

    // 肿瘤诊断(病理)(mipbc)
    // 注意：305 中 'PR结果'（pr结果）= 阳性/阴性 状态；'PR结果.1'（pr结果1）= 百分比数值
    function mergeTumorPathology(patient, accessor) {
      const erStatus = pickValue(accessor, [/^er状态$/]);
      const erResult = pickValue(accessor, [/^er结果$/]);
      const prStatus = pickValue(accessor, [/^pr结果$/]);   // 阳性 / 阴性
      const prResult = pickValue(accessor, [/^pr结果1$/]);  // 数值（如 50）
      const her2IHC  = pickValue(accessor, [/her2结果ihc/, /her2ihc/]);
      const her2ISH  = pickValue(accessor, [/her2结果ish/, /her2ish/]);

      // ER: "80，阳性"
      if (!patient.baseline.er) {
        if (erResult && erStatus)  patient.baseline.er = erResult + '，' + erStatus;
        else if (erStatus)         patient.baseline.er = erStatus;
        else if (erResult)         patient.baseline.er = erResult;
      }
      // PR: "50，阳性"
      if (!patient.baseline.pr) {
        if (prResult && prStatus)  patient.baseline.pr = prResult + '，' + prStatus;
        else if (prStatus)         patient.baseline.pr = prStatus;
        else if (prResult)         patient.baseline.pr = prResult;
      }
      // HER2
      if (!patient.baseline.her2 && her2IHC) {
        patient.baseline.her2 = her2ISH ? her2IHC + ' / ISH:' + her2ISH : her2IHC;
      }
    }

    // 系统性抗肿瘤治疗史
    function mergeSystemicTreatment(patient, accessor) {
      const drugName = pickValue(accessor, ['药物名称', /^药物名称$/]);
      if (!drugName) return;
      const seqNum      = pickValue(accessor, ['序号',       /^序号$/]);
      const txType      = pickValue(accessor, ['治疗设置', '治疗类型', '辅助/新辅助', '新辅助/辅助', /治疗设置/, /治疗类型/, /辅助新辅助/]);
      const regimen     = pickValue(accessor, ['方案',       /^方案$/]);
      const totalCycles = pickValue(accessor, ['总疗程数',   /^总疗程数$/, /疗程数/]);
      const drugTypeRaw = pickValue(accessor, ['药物类型',   /^药物类型$/]);
      const drugTypeOther = pickValue(accessor, ['其他类型', /^其他类型$/]);
      const drugType    = (drugTypeRaw === '其他' && drugTypeOther) ? drugTypeOther : (drugTypeRaw || '');
      const outcomeRaw  = pickValue(accessor, ['治疗结局',   /^治疗结局$/,  '结局', /^结局$/]);
      let outcome = outcomeRaw || '';
      if (outcome.includes('达到预定'))               outcome = '达到';
      else if (outcome.includes('更换方案') || outcome.includes('依据研究者')) outcome = '更换';
      else if (outcome.includes('不耐受') || outcome.includes('毒性')) outcome = '不耐受';
      else if (outcome.includes('其他'))              outcome = '其他';
      patient.systemicList.push({ seqNum: seqNum || '', txType: txType || '', regimen: regimen || '', totalCycles: totalCycles || '', drugName, drugType, outcome });
    }

    // 既往病史(mh)
    function mergeMedicalHistory(patient, accessor) {
      const seqNum   = pickValue(accessor, ['序号',       /^序号$/]);
      const startRaw = pickValue(accessor, ['确诊/开始日期', /确诊开始日期/, /确诊/, /开始日期/, /startdate/]);
      const endRaw   = pickValue(accessor, ['结束日期',      /^结束日期$/,   /enddate/]);
      const name     = pickValue(accessor, ['疾病名称/症状', /疾病名称症状/, /疾病名称/, /症状/, /medicalhistoryterm/, /term/]);
      const ongoing  = pickValue(accessor, ['是否持续',      /^是否持续$/,   /ongoing/]);
      if (!name) return;
      patient.histories.push({
        seqNum: seqNum || '',
        name,
        startDate: formatDate(startRaw),
        startSort: toSortableDate(startRaw),
        ongoing:   ongoing || '未标注',
        endDate:   formatDate(endRaw),
      });
    }

    // 既往及合并用药(cm) — 完整收集每条用药记录
    function mergeCmEntry(patient, accessor) {
      const drugName    = pickValue(accessor, ['药物名称',         /^药物名称$/]);
      if (!drugName) return;
      const seqNum      = pickValue(accessor, ['序号',             /^序号$/]);
      const startRaw    = pickValue(accessor, ['开始日期',         /^开始日期$/]);
      const endRaw      = pickValue(accessor, ['结束日期',         /^结束日期$/]);
      const ongoing     = pickValue(accessor, ['是否持续',         /^是否持续$/]);
      const reason      = pickValue(accessor, ['用药原因',         /^用药原因$/]);
      const reasonDetail= pickValue(accessor, ['用药原因详述',     /^用药原因详述$/]);
      const relMh       = pickValue(accessor, ['相关既往病史序号',   /相关既往病史序号/]);
      const relAe       = pickValue(accessor, ['相关AE序号',       /相关ae序号/]);
      const dose        = pickValue(accessor, ['每次剂量',         /^每次剂量$/]);
      const unitStd     = pickValue(accessor, ['剂量单位',         /^剂量单位$/]);
      const unitOther   = pickValue(accessor, ['其他单位',         /^其他单位$/]);
      const form        = pickValue(accessor, ['剂型',             /^剂型$/]);
      const formOther   = pickValue(accessor, ['其他剂型',         /^其他剂型$/]);
      const route       = pickValue(accessor, ['给药途径',         /^给药途径$/]);
      const routeOther  = pickValue(accessor, ['其他途径',         /^其他途径$/]);
      const freq        = pickValue(accessor, ['给药频率',         /^给药频率$/]);
      const freqOther   = pickValue(accessor, ['其他频率',         /^其他频率$/]);

      const unit         = unitOther || unitStd;
      const doseDisplay  = dose ? (unit ? dose + unit : dose) : '';
      const formDisplay  = form  === '其他' ? (formOther  || form)  : (form  || '');
      const routeDisplay = route === '其他' ? (routeOther || route) : (route || '');
      const freqDisplay  = freq  === '其他' ? (freqOther  || freq)  : (freq  || '');
      const reasonDisplay = (reasonDetail && reasonDetail !== reason)
        ? reason + '（' + reasonDetail + '）'
        : (reason || '');

      patient.cmList.push({
        seqNum:      seqNum || '',
        name:        drugName,
        dose:        doseDisplay,
        form:        formDisplay,
        route:       routeDisplay,
        freq:        freqDisplay,
        startDate:   formatDate(startRaw),
        sortableDate: toSortableDate(startRaw),
        ongoing:     ongoing || '',
        endDate:     formatDate(endRaw),
        reason:      reasonDisplay,
        relMh:       relMh || '',
        relAe:       relAe || '',
      });
    }

    // 不良事件(ae) — 305 有5种药物对应的采取措施字段，完整收集每条 AE 记录
    function mergeAdverseEvent(patient, accessor) {
      const aeName = pickValue(accessor, ['不良事件名称', /不良事件名称/]);
      if (!aeName) return;
      const seqNum    = pickValue(accessor, ['序号',         /^序号$/]);
      const startRaw   = pickValue(accessor, ['开始日期',   /^开始日期$/]);
      const outcome    = pickValue(accessor, ['AE转归',      /^ae转归$/]);
      const outcomeRaw = pickValue(accessor, ['转归日期',    /^转归日期$/]);
      const grade      = pickValue(accessor, ['CTCAE分级',   /ctcae分级/]);
      const hasCorrect = pickValue(accessor, ['是否有纠正治疗', /是否有纠正治疗/]);
      const isSae      = pickValue(accessor, ['是否是严重不良事件',       /是否是严重不良事件/]);
      const isAesi     = pickValue(accessor, ['是否是特别关注的不良事件', /是否是特别关注的不良事件/]);
      // 5种药物：关系+措施全部保留（含不适用/剂量不变，对照组才能正确显示）
      const drugInfoList = [
        { drug: 'HRS-8080', ac: '对HRS-8080采取措施', re: '与HRS-8080的关系' },
        { drug: '来曲唑',   ac: '对来曲唑采取措施',   re: '与来曲唑的关系' },
        { drug: '阿那曲唑', ac: '对阿那曲唑采取措施', re: '与阿那曲唑的关系' },
        { drug: '依西美坦', ac: '对依西美坦采取措施', re: '与依西美坦的关系' },
        { drug: '他莫昔芬', ac: '对他莫昔芬采取措施', re: '与他莫昔芬的关系' },
      ];
      const drugDetails = [];
      drugInfoList.forEach(({ drug, ac, re }) => {
        const action = pickValue(accessor, [ac]);
        const rel    = pickValue(accessor, [re]);
        if (action || rel) {
          drugDetails.push({ drug, action: action || '', rel: rel || '' });
          if (action && action !== '剂量不变' && action !== '不适用') {
            patient.aeActions.push(drug + '：' + action);
          }
        }
      });
      patient.aeList.push({
        seqNum:            seqNum || '',
        name:              aeName,
        startDate:         formatDate(startRaw),
        sortableDate:      toSortableDate(startRaw),
        endSortableDate:   outcomeRaw ? toSortableDate(outcomeRaw) : Number.MAX_SAFE_INTEGER,
        ong:               !outcomeRaw || (outcome || '') === '持续中',
        outcome:           outcome || '',
        outcomeDate:       formatDate(outcomeRaw),
        grade:             grade || '',
        hasCorrect:        hasCorrect || '',
        isSae:             isSae || '',
        isAesi:            isAesi || '',
        drugDetails,
        'AE转归': outcome || '',
        '对HRS-8080采取措施': drugDetails.find((item) => item.drug === 'HRS-8080')?.action || '',
        '与HRS-8080的关系': drugDetails.find((item) => item.drug === 'HRS-8080')?.rel || '',
        '对来曲唑采取措施': drugDetails.find((item) => item.drug === '来曲唑')?.action || '',
        '与来曲唑的关系': drugDetails.find((item) => item.drug === '来曲唑')?.rel || '',
        '对阿那曲唑采取措施': drugDetails.find((item) => item.drug === '阿那曲唑')?.action || '',
        '与阿那曲唑的关系': drugDetails.find((item) => item.drug === '阿那曲唑')?.rel || '',
        '对依西美坦采取措施': drugDetails.find((item) => item.drug === '依西美坦')?.action || '',
        '与依西美坦的关系': drugDetails.find((item) => item.drug === '依西美坦')?.rel || '',
        '对他莫昔芬采取措施': drugDetails.find((item) => item.drug === '他莫昔芬')?.action || '',
        '与他莫昔芬的关系': drugDetails.find((item) => item.drug === '他莫昔芬')?.rel || '',
      });
    }

    // 实验室检查(lb) — 305 使用中文字段
    function extractLabEntry(accessor) {
      const name   = pickValue(accessor, ['检查项', /^检查项$/, /testname/, /examname/]);
      const result = pickValue(accessor, ['结果',   /^结果$/,   /^result$/, /lbresult/]);
      if (!name || !result) return null;

      const unit         = pickValue(accessor, [/^单位$/,         /^unit$/]);
      const moduleName   = pickValue(accessor, ['模块名称',     /^模块名称$/,     /modulename/]) || '未分类模块';
      const lowValue     = pickValue(accessor, ['正常值范围-下限', /正常值范围下限/, /referencelow/,  /lowlimit/]);
      const highValue    = pickValue(accessor, ['正常值范围-上限', /正常值范围上限/, /referencehigh/, /highlimit/]);
      const standardResult = pickValue(accessor, ['标准单位检测值', /标准单位检测值/]);
      const standardLow    = pickValue(accessor, ['标准单位下限', /标准单位下限/]);
      const standardHigh   = pickValue(accessor, ['标准单位上限', /标准单位上限/]);
      const standardUnit   = pickValue(accessor, [/^标准单位$/, /^standardunit$/]) || unit;
      const collectionDate = pickValue(accessor, ['采样日期',   /^采样日期$/,     /collectiondate/]);
      const visitValue   = pickValue(accessor, ['访视名称',     /^访视名称$/,     /visitname/]);
      const significance = pickValue(accessor, ['临床意义',     /^临床意义$/,     /clinicalsignificance/]);

      return {
        moduleName,
        name,
        result,
        unit,
        standardUnit,
        standardResult: standardResult || result,
        standardLow: standardLow || lowValue,
        standardHigh: standardHigh || highValue,
        referenceLow: lowValue,
        referenceHigh: highValue,
        referenceRange: buildReferenceRange(lowValue, highValue, ''),
        collectionDate: formatDate(collectionDate),
        sortableDate:   toSortableDate(collectionDate),
        visitLabel:     formatVisitLabel(visitValue),
        significance:   significance || '',
        abnormality:    detectAbnormality(result, lowValue, highValue, ''),
      };
    }

    // 体重(vswt)
    function extractWeightEntry(accessor) {
      const weightValue = pickValue(accessor, ['体重', /^体重$/, /bodyweight/]);
      if (!weightValue) return null;
      const unit      = pickValue(accessor, ['体重单位', /^体重单位$/, /weightunit/]) || 'kg';
      const dateValue = pickValue(accessor, ['检查日期', /^检查日期$/, /visitdate/, /collectiondate/]);
      const visitValue= pickValue(accessor, ['访视名称', /^访视名称$/, /visitname/]);
      return {
        moduleName:     '体重',
        name:           '体重',
        result:         weightValue,
        unit,
        referenceRange: '-',
        collectionDate: formatDate(dateValue),
        sortableDate:   toSortableDate(dateValue),
        visitLabel:     formatVisitLabel(visitValue),
        significance:   '',
        abnormality:    'normal',
        isWeight:       true,
        weightAlert:    false,
      };
    }

    // 提取患者编号 — 优先查 参与者代码 字段
    function extractPatientId(accessor) {
      const direct = pickValue(accessor, ['参与者代码', /^参与者代码$/, /subjectid/, /participantid/]);
      if (direct) {
        const match = direct.match(patientIdPattern);
        if (match) return match[0].toUpperCase();
      }
      for (const entry of accessor.entries) {
        const match = entry.value.match(patientIdPattern);
        if (match) return match[0].toUpperCase();
      }
      return '';
    }

    // ── 针对 肿瘤影像学(tu) 的特殊解析（V0.1 占位，字段待确认）──
    function parseResponseAssessmentWorksheet(worksheet, patients) {
      const rows = self.XLSX.utils.sheet_to_json(worksheet, {
        header: 1, defval: '', raw: false, dateNF: 'yyyy-mm-dd',
      });
      if (!rows.length) return;
      const headers = (rows[0] || []).map((v) => normalizeKey(v));
      const patientIdIndex = headers.findIndex((h) => h === '参与者代码' || /^参与者代码$/.test(h) || /^subjectid$/.test(h));

      for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex].map((v) => stringify(v));
        const patientSource = patientIdIndex >= 0 ? row[patientIdIndex] : row.join(' | ');
        const match = stringify(patientSource).match(patientIdPattern);
        if (!match) continue;

        const patientId = match[0].toUpperCase();
        if (!patients.has(patientId)) patients.set(patientId, createEmptyPatient(patientId));
        const patient = patients.get(patientId);
        patient.rowCount += 1;

        // V0.1 暂不解析具体肿评字段
      }
    }

    // 给药记录解析（305 口服连续用药，每行是一个治疗周期）
    function mergeDrugAdmin305(patient, accessor, drugName) {
      const startRaw = pickValue(accessor, ['开始日期', /^开始日期$/]);
      if (!startRaw) return;
      const endRaw = pickValue(accessor, ['结束日期', /^结束日期$/]);
      const visitValue = pickValue(accessor, ['访视名称', /^访视名称$/]);
      const doseAdjRaw = pickValue(accessor, ['计划剂量是否暂停或调整', /计划剂量是否暂停或调整/, /暂停或调整/]);
      const doseAmt = (pickValue(accessor, ['计划每次给药剂量', '计划给药剂量', /计划每次给药剂量/, /^计划给药剂量$/]) || '').trim();
      const unit = (pickValue(accessor, ['计划给药剂量单位', /计划给药剂量单位/]) || '').trim();
      patient.drugAdmins.push({
        drug: drugName,
        date: formatDate(startRaw),
        sortableDate: toSortableDate(startRaw),
        endDate: endRaw ? formatDate(endRaw) : '',
        endSortableDate: endRaw ? toSortableDate(endRaw) : Number.MAX_SAFE_INTEGER,
        visit: formatVisitLabel(visitValue),
        doseAdjusted: !!(doseAdjRaw && (doseAdjRaw === '是' || doseAdjRaw.toLowerCase().startsWith('y'))),
        doseLevel: doseAmt ? (unit ? doseAmt + ' ' + unit : doseAmt) : '',
      });
    }

    self.onmessage = (event) => {
      try {
        const workbook = self.XLSX.read(event.data.buffer, {
          type: 'array', cellDates: false, dense: true,
          cellNF: false, cellHTML: false, cellStyles: false,
        });
        const patients = new Map();
        const parseBasePercent = 20;
        const parseSpanPercent = 66;

        for (let sheetIndex = 0; sheetIndex < workbook.SheetNames.length; sheetIndex += 1) {
          const sheetName    = workbook.SheetNames[sheetIndex];
          const sheetContext = detectSheetContext(sheetName);
          if (sheetContext === 'other') continue;

          const progressRatio = workbook.SheetNames.length
            ? (sheetIndex + 1) / workbook.SheetNames.length : 1;
          const percent = Math.max(parseBasePercent, Math.min(86,
            Math.round(parseBasePercent + progressRatio * parseSpanPercent)));
          self.postMessage({
            type: 'progress', percent,
            message: '正在解析 ' + sheetName + ' (' + (sheetIndex + 1) + '/' + workbook.SheetNames.length + ')...',
          });

          if (sheetContext === 'responseAssessment') {
            parseResponseAssessmentWorksheet(workbook.Sheets[sheetName], patients);
            continue;
          }

          const rows = self.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
            defval: '', raw: true,
          });

          rows.forEach((row, rowIndex) => {
            const accessor  = createAccessor(row);
            const patientId = extractPatientId(accessor);
            if (!patientId) return;

            if (!patients.has(patientId)) patients.set(patientId, createEmptyPatient(patientId));
            const patient = patients.get(patientId);
            patient.rowCount += 1;

            if (sheetContext === 'visitDate' || sheetContext === 'dummySv' || sheetContext === 'laboratory' || sheetContext === 'weight') {
              mergeDummySvRow(patient, accessor);
            }
            if (sheetContext === 'subjectInformation')  mergeSubjectInformation(patient, accessor);
            if (sheetContext === 'visitDate')            mergeVisitDate(patient, accessor);
            if (sheetContext === 'randomization')        mergeRandomization(patient, accessor);
            if (sheetContext === 'stratificationFactor') mergeStratificationFactor(patient, accessor);
            if (sheetContext === 'tumorBreast')          mergeTumorBreast(patient, accessor);
            if (sheetContext === 'tumorPathology')       mergeTumorPathology(patient, accessor);
            if (sheetContext === 'medicalHistory')       mergeMedicalHistory(patient, accessor);
            if (sheetContext === 'concomitantMed')       mergeCmEntry(patient, accessor);
            if (sheetContext === 'adverseEvent')         mergeAdverseEvent(patient, accessor);
            if (sheetContext === 'systemicTreatment')    mergeSystemicTreatment(patient, accessor);
            if (sheetContext === 'hrs8080Admin')      mergeDrugAdmin305(patient, accessor, 'HRS-8080');
            if (sheetContext === 'letrozoleAdmin')    mergeDrugAdmin305(patient, accessor, '来曲唑');
            if (sheetContext === 'tamoxifenAdmin')    mergeDrugAdmin305(patient, accessor, '他莫昔芬');
            if (sheetContext === 'anastrozoleAdmin')  mergeDrugAdmin305(patient, accessor, '阿那曲唑');
            if (sheetContext === 'exemestaneAdmin')   mergeDrugAdmin305(patient, accessor, '依西美坦');
            if (sheetContext === 'weight') {
              const weightEntry = extractWeightEntry(accessor);
              if (weightEntry) patient.labs.push(weightEntry);
            }
            if (sheetContext === 'laboratory') {
              const labEntry = extractLabEntry(accessor);
              if (labEntry) {
                labEntry.sourceOrder = sheetIndex * 1000000 + rowIndex;
                patient.labs.push(labEntry);
              }
            }
          });
        }

        patients.forEach(function(p) { p.drugAdmins.sort(function(a,b){return a.sortableDate-b.sortableDate;}); });
        self.postMessage({ type: 'result', patients: Array.from(patients.values()) });
      } catch (error) {
        self.postMessage({ type: 'error', error: error && error.message ? error.message : String(error) });
      }
    };
  `;
}

// ═══════════════════════════════════════════════════════
// 主线程辅助函数（与 Worker 内保持同步）
// ═══════════════════════════════════════════════════════
function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function stringify(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeKey(value) {
  return stringify(value)
    .toLowerCase()
    .replace(/[\s_\-\/()\[\]{}]+/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function createEmptyPatient(patientId) {
  return {
    patientId,
    center: "",
    subjectStatus: "",
    currentVisit: "",
    currentVisitSort: Number.NEGATIVE_INFINITY,
    stratification: { menoStatus: "", cancerStage: "", lymphNodes: "", cdk46Duration: "" },
    rowCount: 0,
    baseline: {
      group: "",
      grade: "", pathGrade: "",
      cTnm: "",  pTnm: "",
      tumorSize: "", lymphCount: "",
      er: "", pr: "", her2: "",
      tStage: "", nStage: "", ajcc: "", mStage: "",
    },
    labs: [], groupedLabs: [], svRows: [], dummy_sv: [], labAeList: [], drugAdmins: [], histories: [], responses: [], cmList: [], aeList: [], aeActions: [], systemicList: [], criticalHints: [], questions: [], abnormalCount: 0,
  };
}

function parseNumeric(value) {
  if (!value) return Number.NaN;
  const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function toSortableDate(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(String(value).replace(/\./g, "-").replace(/\//g, "-"));
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function buildReferenceRange(lowValue, highValue, rawRange) {
  if (lowValue || highValue) return `${lowValue || "?"} - ${highValue || "?"}`;
  return rawRange || "未提供";
}

function formatDate(value) {
  if (!value) return "未提供";
  if (typeof value === "number" && window.XLSX && window.XLSX.SSF) {
    const parsed = window.XLSX.SSF.parse_date_code(value);
    if (parsed) return new Intl.DateTimeFormat("zh-CN").format(new Date(parsed.y, parsed.m - 1, parsed.d));
  }
  const date = new Date(String(value).replace(/\./g, "-").replace(/\//g, "-"));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN").format(date);
}

function formatVisitLabel(value) {
  const raw = stringify(value);
  if (!raw) return "";
  if (raw.toLowerCase().includes("screening")) return "筛选期";
  if (raw.toLowerCase().includes("unscheduled")) return "计划外";
  return raw;
}

function formatResultDateLabel(entry) {
  const parts = [];
  if (entry.collectionDate && entry.collectionDate !== "未提供") parts.push(entry.collectionDate);
  if (entry.visitLabel) parts.push(entry.visitLabel);
  return parts.join(" · ") || "未提供";
}

// 305 分层信息展示
function formatStratificationText(patient) {
  const parts = [
    patient.stratification.menoStatus,
    patient.stratification.cancerStage,
    patient.stratification.lymphNodes,
    patient.stratification.cdk46Duration,
  ].filter(Boolean);
  return parts.length ? `分层因素：${parts.join(" · ")}` : "分层因素：未提供";
}

// 305 受试者状态文本
function formatSubjectStatusText(value) {
  const normalized = stringify(value).toLowerCase();
  if (normalized.includes("筛败") || normalized.includes("screen failed") || normalized.includes("screenfailed")) return "筛败";
  if (normalized.includes("筛选") || normalized.includes("screening")) return "筛选中";
  if (normalized.includes("已入组") || normalized.includes("治疗") || normalized.includes("研究完成") || normalized.includes("enrolled")) return "已入组";
  return value || "";
}

function getSubjectStatusClass(value) {
  const normalized = stringify(value).toLowerCase();
  if (normalized.includes("筛败") || normalized.includes("screen failed") || normalized.includes("screenfailed")) return "status-failed";
  if (normalized.includes("筛选") || normalized.includes("screening")) return "status-screening";
  if (normalized.includes("已入组") || normalized.includes("治疗") || normalized.includes("研究完成") || normalized.includes("enrolled")) return "status-enrolled";
  return "status-unknown";
}

function renderStatusBadge(value) {
  const className = getSubjectStatusClass(value);
  if (className === "status-unknown") return "";
  const label = formatSubjectStatusText(value);
  return `<span class="status-dot ${className}" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}"></span>`;
}

// 305 临床意义 → CS / NCS 徽章
function formatSignificance(value) {
  const normalized = stringify(value).toLowerCase();
  if (!normalized || normalized === "正常" || normalized === "normal") return "";
  if (normalized.includes("有临床意义") || normalized === "cs") return "CS";
  if (normalized.includes("无临床意义") || normalized === "ncs") return "NCS";
  if (normalized.includes("clinically significant") && !normalized.includes("not")) return "CS";
  if (normalized.includes("not clinically significant")) return "NCS";
  return "";
}

function isCriticalSignificance(value) {
  return formatSignificance(value) === "CS";
}

function collectCenterOptions(patients) {
  const centers = new Set();
  patients.forEach((patient) => { if (patient.center) centers.add(patient.center); });
  return Array.from(centers).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function finalizePatient(patient) {
  // cTNM 兜底构建（Worker 未覆盖到时）
  if (!patient.baseline.cTnm) {
    const tnPart = [patient.baseline.tStage, patient.baseline.nStage].filter(Boolean).join('');
    if (tnPart || patient.baseline.ajcc) {
      patient.baseline.cTnm = [tnPart, patient.baseline.ajcc].filter(Boolean).join(' ');
    }
  }

  // 按模块和检查项分组（跳过激素检查）
  const grouped = new Map();
  patient.labs.forEach((entry) => {
    const moduleKey = entry.moduleName.trim() || "未分类模块";
    if (moduleKey.includes('激素')) return;
    if (!grouped.has(moduleKey)) grouped.set(moduleKey, new Map());
    const moduleEntries = grouped.get(moduleKey);
    const labKey = entry.name.trim();
    if (!moduleEntries.has(labKey)) moduleEntries.set(labKey, []);
    moduleEntries.get(labKey).push(entry);
  });

  patient.groupedLabs = Array.from(grouped.entries())
    .map(([moduleName, labMap]) => ({
      moduleName,
      items: Array.from(labMap.entries()).map(([name, entries]) => ({
        name,
        entries: entries.sort((a, b) => a.sortableDate - b.sortableDate),
      })),
    }))
    .sort((a, b) => a.moduleName.localeCompare(b.moduleName, "zh-CN"));

  patient.groupedLabs.forEach((group) => {
    group.items.forEach((item) => {
      item.trend = buildLabTrend(item);
    });
  });

  // 体重变化超 10% 标记
  patient.groupedLabs.forEach((group) => {
    group.items.forEach((item) => {
      if (!item.entries.some((e) => e.isWeight)) return;
      const baselineWeight = item.entries.length ? parseNumeric(item.entries[0].result) : Number.NaN;
      if (!Number.isFinite(baselineWeight) || baselineWeight === 0) return;
      item.entries.forEach((entry, index) => {
        if (index === 0) return;
        const cur = parseNumeric(entry.result);
        if (Number.isFinite(cur) && Math.abs(cur - baselineWeight) / baselineWeight > 0.1) {
          entry.weightAlert = true;
        }
      });
    });
    group.hasCritical = group.items.some((item) =>
      item.entries.some((e) => isCriticalSignificance(e.significance))
    );
  });

  patient.histories = patient.histories
    .sort((a, b) => a.startSort - b.startSort)
    .filter((entry, index, list) =>
      list.findIndex((c) =>
        c.name === entry.name && c.startDate === entry.startDate &&
        c.ongoing === entry.ongoing && c.endDate === entry.endDate
      ) === index
    );

  patient.responses = patient.responses
    .sort((a, b) => {
      const as = Number.isFinite(a.sortableDate) ? a.sortableDate : Number.MAX_SAFE_INTEGER;
      const bs = Number.isFinite(b.sortableDate) ? b.sortableDate : Number.MAX_SAFE_INTEGER;
      return as !== bs ? as - bs : a.sequence - b.sequence;
    })
    .filter((entry, index, list) =>
      list.findIndex((c) =>
        c.visit === entry.visit && c.targetResponse === entry.targetResponse &&
        c.nonTargetResponse === entry.nonTargetResponse &&
        c.newLesion === entry.newLesion && c.overallResponse === entry.overallResponse
      ) === index
    );

  patient.abnormalCount = patient.labs.filter((e) => e.abnormality !== "normal").length;
  if (patient.drugAdmins && patient.drugAdmins.length) {
    patient.drugAdmins.sort((a, b) => a.sortableDate - b.sortableDate);
  }
  patient.criticalHints = buildCriticalHints(patient);
  patient.questions     = buildQuestions(patient);
}

function buildCriticalHints(patient) {
  const hints = [];

  if (patient.aeActions.length) {
    const uniqueActions = [...new Set(patient.aeActions)].slice(0, 3);
    hints.push(`受试者因 AE 发生用药调整（${uniqueActions.join("、")}），请核实给药记录与 EOT 界面。`);
  }

  const groupedCriticalLabs = new Map();
  patient.groupedLabs.forEach((group) => {
    group.items.forEach((item) => {
      if (item.entries.some((e) => isCriticalSignificance(e.significance))) {
        if (!groupedCriticalLabs.has(group.moduleName)) groupedCriticalLabs.set(group.moduleName, []);
        groupedCriticalLabs.get(group.moduleName).push(item.name);
      }
    });
  });

  if (groupedCriticalLabs.size) {
    const mergedText = Array.from(groupedCriticalLabs.entries())
      .map(([moduleName, items]) => `${moduleName}（${[...new Set(items)].join("、")}）`)
      .join("；");
    hints.push(`具有临床意义的异常检查结果包括：${mergedText}`);
  }

  return hints;
}

function buildLabTrend(item) {
  const hasCS = item.entries.some((entry) => isCriticalSignificance(entry.significance));
  if (!hasCS) return { available: false, points: [] };

  const units = new Set(item.entries.map((entry) => stringify(entry.unit)));
  const hasBlankUnit = units.has("");
  const nonBlankUnits = [...units].filter(Boolean);
  if (nonBlankUnits.length > 1 || (hasBlankUnit && nonBlankUnits.length > 0)) {
    return { available: false, points: [] };
  }

  const lastByDate = new Map();
  item.entries.forEach((entry) => {
    if (!Number.isFinite(entry.sortableDate)) return;
    const numericResult = parseNumeric(entry.result);
    if (!Number.isFinite(numericResult)) return;
    const current = lastByDate.get(entry.sortableDate);
    if (!current || (entry.sourceOrder || 0) >= (current.sourceOrder || 0)) {
      lastByDate.set(entry.sortableDate, {
        date: entry.collectionDate,
        value: numericResult,
        sourceOrder: entry.sourceOrder || 0,
      });
    }
  });

  const points = [...lastByDate.entries()]
    .sort(([dateA], [dateB]) => dateA - dateB)
    .map(([, point]) => point);
  return { available: points.length >= 2, points };
}

function buildQuestions(patient) {
  const questions = [];
  const missingFields = baselineFields
    .filter((field) => !stringify(patient.baseline[field.key]))
    .map((field) => field.label);

  if (missingFields.length) {
    questions.push({ type: "warning", title: "基线字段缺失", detail: missingFields.join("、") });
  }

  if (!patient.groupedLabs.length) {
    questions.push({ type: "warning", title: "缺少实验室记录", detail: "未在 实验室检查(lb) 中识别到该患者记录。" });
  }

  if (patient.abnormalCount) {
    questions.push({ type: "alert", title: "存在异常结果", detail: `共识别到 ${patient.abnormalCount} 条高/低异常结果。` });
  }

  if (!questions.length) {
    questions.push({ type: "normal", title: "当前无明显缺口", detail: "基线字段与实验室记录已成功识别，可继续人工核查。" });
  }

  return questions;
}

// ═══════════════════════════════════════════════════════
// 渲染层（与 312 保持一致）
// ═══════════════════════════════════════════════════════
function renderAll() {
  const fileNotes = [formatWorkbookNote(state.workbookName)];
  if (state.aeCodingName) fileNotes.push(`AE 编码：${state.aeCodingName}`);
  elements.workbookName.textContent = fileNotes.filter(Boolean).join(" · ");
  renderPatientControls();
  renderPatientView();
}

function renderPatientControls() {
  const keyword = elements.patientSearch.value.trim().toUpperCase();
  renderCenterOptions();
  state.filteredIds = state.patientIds.filter((patientId) => {
    const patient = state.patients.get(patientId);
    return patientId.includes(keyword) &&
      (state.selectedCenter === "ALL" || patient.center === state.selectedCenter);
  });
  if (!state.filteredIds.includes(state.selectedPatientId)) {
    state.selectedPatientId = state.filteredIds[0] || "";
  }

  elements.patientCountBadge.textContent = `${state.filteredIds.length}/${state.patientIds.length} 人`;
  elements.patientSelect.innerHTML = "";

  if (!state.patientIds.length) {
    elements.patientSelect.innerHTML = '<option value="">请先上传 Excel</option>';
    elements.patientList.className = "patient-list empty-list";
    elements.patientList.textContent = "载入数据后会在这里显示患者列表";
    return;
  }

  state.filteredIds.forEach((patientId) => {
    const option = document.createElement("option");
    option.value = patientId;
    option.textContent = formatPatientOptionLabel(state.patients.get(patientId));
    option.selected = patientId === state.selectedPatientId;
    elements.patientSelect.appendChild(option);
  });

  if (!state.filteredIds.length) {
    elements.patientSelect.innerHTML = '<option value="">未找到匹配患者</option>';
  }

  elements.patientList.className = state.filteredIds.length ? "patient-list" : "patient-list empty-list";
  elements.patientList.innerHTML = "";

  if (!state.filteredIds.length) {
    elements.patientList.textContent = "没有符合当前筛选条件的患者";
    return;
  }

  state.filteredIds.forEach((patientId) => {
    const patient = state.patients.get(patientId);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `patient-row${patientId === state.selectedPatientId ? " active" : ""}`;
    row.innerHTML = `
      <span class="patient-id-text">${patientId}${renderStatusBadge(patient.subjectStatus)}</span>
      <small class="patient-center-text">${patient.center ? escapeHtml(patient.center) : "中心未识别"}</small>
    `;
    row.addEventListener("click", () => setSelectedPatient(patientId));
    elements.patientList.appendChild(row);
  });
}

function renderCenterOptions() {
  const options = ['<option value="ALL">全部中心</option>']
    .concat(state.centerOptions.map((c) => `<option value="${escapeAttribute(c)}">${escapeHtml(c)}</option>`));
  elements.centerSelect.innerHTML = options.join("");
  elements.centerSelect.value = state.selectedCenter;
}

function formatPatientOptionLabel(patient) {
  if (!patient) return "";
  const statusText = formatSubjectStatusText(patient.subjectStatus);
  const parts = [patient.patientId];
  if (statusText) parts.push(statusText);
  if (patient.center) parts.push(patient.center);
  return parts.join(" | ");
}

function setSelectedPatient(patientId) {
  state.selectedPatientId = patientId;
  elements.patientSelect.value = patientId;
  renderPatientControls();
  renderPatientView();
}

function renderPatientView() {
  const patient = state.patients.get(state.selectedPatientId);
  if (!patient) {
    elements.selectedPatientTitle.textContent = state.workbookName ? "未找到患者" : "等待数据载入";
    elements.selectedPatientSubtitle.textContent = state.workbookName
      ? "当前筛选条件下没有可显示的患者。"
      : "上传 Excel 后可在左侧按中心和患者编号筛选。";
    elements.selectedPatientStratification.textContent = "分层因素：未提供";
    elements.aeActionBar.innerHTML = "";
    elements.cmActionBar.innerHTML = "";
    elements.labAeActionBar.innerHTML = "";
    elements.heroHintContent.innerHTML = '<p class="hero-hint-title">重点数据提示</p><p>上传 Excel 后会在这里显示需要优先核查的患者级风险信息。</p>';
    elements.baselineGrid.innerHTML = '<article class="baseline-card empty-card">暂无数据</article>';
    elements.questionPanel.innerHTML = '<article class="question-empty">上传 Excel 后将自动提示缺失字段与异常结果。</article>';
    elements.historyList.innerHTML   = '<article class="history-card empty-card">暂无既往史数据</article>';
    elements.systemicList.innerHTML  = '<article class="history-card empty-card">暂无系统性抗肿瘤治疗史</article>';
    elements.responseList.innerHTML  = '<article class="history-card empty-card">待更新</article>';
    elements.labsGrid.innerHTML      = '<article class="lab-card empty-card">暂无实验室结果</article>';
    elements.labCountBadge.textContent = "0 组";
    return;
  }

  elements.selectedPatientTitle.textContent = patient.patientId;
  const groupWithVisit = patient.currentVisit
    ? `${patient.baseline.group || "分组未识别"} · ${patient.currentVisit}`
    : (patient.baseline.group || "分组未识别");
  elements.selectedPatientSubtitle.textContent =
    `${patient.center || "中心未识别"} | ${groupWithVisit} | ${countLabItems(patient.groupedLabs)} 个实验室结果 | ${patient.abnormalCount} 条异常`;
  elements.selectedPatientStratification.textContent = formatStratificationText(patient);
  elements.aeActionBar.innerHTML = patient.aeList.length
    ? `<button class="ae-open-btn" id="aeOpenBtn">&#128203; 查看不良事件（${patient.aeList.length} 条）</button>`
    : "";
  if (patient.aeList.length) {
    document.getElementById("aeOpenBtn").addEventListener("click", () => openAeWindow(patient));
  }
  elements.cmActionBar.innerHTML = patient.cmList.length
    ? `<button class="ae-open-btn" id="cmOpenBtn">&#128138; 查看合并用药（${patient.cmList.length} 条）</button>`
    : "";
  if (patient.cmList.length) {
    document.getElementById("cmOpenBtn").addEventListener("click", () => openCmWindow(patient));
  }
  const linkedLabAe = patient.labae_ae_linked || [];
  const labAeRecords = (patient.labae_out || [])
    .filter((lab) => {
      const grade = Number.parseInt(String(lab?.LABAE_GRD || "").replace(/[^0-9]/g, ""), 10) || 0;
      return Boolean(lab?.LBTEST_CN || lab?.["HRSTD LBTEST-CN"]) && grade >= 1;
    })
    .map((lab) => {
      const linked = linkedLabAe.find((record) => {
        const linkedLab = record?.build_ctc_out || {};
        return String(linkedLab.LBTEST_CN || linkedLab["HRSTD LBTEST-CN"] || "") ===
          String(lab.LBTEST_CN || lab["HRSTD LBTEST-CN"] || "") &&
          String(linkedLab.collectionDate || "") === String(lab.collectionDate || "");
      });
      return linked || { "参与者代码": patient.patientId, build_ctc_out: lab, ae_normalized: {} };
    });
  elements.labAeActionBar.innerHTML = labAeRecords.length
    ? `<button class="ae-open-btn" id="labAeOpenBtn">&#128202; 查看Lab-AE（${labAeRecords.length} 条）</button>`
    : "";
  if (labAeRecords.length) {
    document.getElementById("labAeOpenBtn").addEventListener("click", () => openLabAeWindow(patient, labAeRecords));
  }
  elements.labCountBadge.textContent = `${patient.groupedLabs.length} 组`;
  elements.heroHintContent.innerHTML = renderCriticalHints(patient.criticalHints);

  // 基线数据
  elements.baselineGrid.innerHTML = baselineFields
    .map((field) => `
      <article class="baseline-card">
        <span class="baseline-label">${field.label}</span>
        <strong class="baseline-value">${escapeHtml(patient.baseline[field.key] || "未识别")}</strong>
      </article>
    `)
    .join("");

  // 数据提示
  elements.questionPanel.innerHTML = patient.questions
    .map((item) => `
      <article class="question-item ${item.type}">
        <span class="question-type">${item.type === "alert" ? "关注" : item.type === "warning" ? "补核" : "概览"}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </article>
    `)
    .join("");

  elements.historyList.innerHTML  = renderHistoryList(patient.histories);
  elements.systemicList.innerHTML = renderSystemicList(patient.systemicList);
  elements.responseList.innerHTML = renderResponseList(patient.responses);

  if (!patient.groupedLabs.length) {
    elements.labsGrid.innerHTML = '<article class="lab-card empty-card">暂无实验室结果</article>';
    return;
  }
  elements.labsGrid.innerHTML = patient.groupedLabs.map((group) => renderLabModule(group)).join("");
  bindLabTrendControls(patient);
}

function countLabItems(groups) {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

function renderHistoryList(histories) {
  if (!histories.length) return '<article class="history-card empty-card">暂无既往史数据</article>';
  return `
    <div class="history-table-wrap">
      <div class="history-table">
        <div class="history-row history-header-row">
          <span class="history-header-cell">序号</span>
          <span class="history-header-cell">名称</span>
          <span class="history-header-cell">开始时间</span>
          <span class="history-header-cell">结束时间</span>
          <span class="history-header-cell">是否持续</span>
        </div>
        ${histories.map((h, i) => `
          <div class="history-row">
            <span class="history-value-cell">${escapeHtml(h.seqNum || String(i + 1))}</span>
            <span class="history-value-cell">${escapeHtml(h.name)}</span>
            <span class="history-value-cell">${escapeHtml(h.startDate || "未提供")}</span>
            <span class="history-value-cell">${escapeHtml(h.endDate || "未提供")}</span>
            <span class="history-value-cell">${escapeHtml(h.ongoing)}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderSystemicList(list) {
  if (!list || !list.length) return '<article class="history-card empty-card">暂无系统性抗肿瘤治疗史</article>';
  // 按序号分组
  const groups = [];
  const seen = new Map();
  list.forEach((item) => {
    const key = item.seqNum || item.regimen || item.txType;
    if (!seen.has(key)) {
      const g = { seqNum: item.seqNum, txType: item.txType, regimen: item.regimen, totalCycles: item.totalCycles, drugs: [] };
      seen.set(key, g);
      groups.push(g);
    }
    seen.get(key).drugs.push({ name: item.drugName, type: item.drugType, outcome: item.outcome });
  });
  const rows = groups.map((g) => {
    const drugCell    = g.drugs.map((d) => d.type ? `${escapeHtml(d.name)}/${escapeHtml(d.type)}` : escapeHtml(d.name)).join('、');
    const outcomeCell = g.drugs.map((d) => d.outcome ? `${escapeHtml(d.name)}/${escapeHtml(d.outcome)}` : escapeHtml(d.name)).join('、');
    return `
      <div class="history-row">
        <span class="history-value-cell">${escapeHtml(g.seqNum)}</span>
        <span class="history-value-cell">${escapeHtml(g.txType) || '—'}</span>
        <span class="history-value-cell">${escapeHtml(g.regimen) || '—'}</span>
        <span class="history-value-cell">${escapeHtml(g.totalCycles) || '—'}</span>
        <span class="history-value-cell">${drugCell || '—'}</span>
        <span class="history-value-cell">${outcomeCell || '—'}</span>
      </div>
    `;
  }).join("");
  return `
    <div class="history-table-wrap">
      <div class="history-table systemic-table">
        <div class="history-row history-header-row">
          <span class="history-header-cell">序号</span>
          <span class="history-header-cell">治疗类型</span>
          <span class="history-header-cell">方案</span>
          <span class="history-header-cell">总疗程数</span>
          <span class="history-header-cell">药物名称/类型</span>
          <span class="history-header-cell">治疗结局</span>
        </div>
        ${rows}
      </div>
    </div>
  `;
}

function renderResponseList(responses) {
  if (!responses.length) return '<article class="history-card empty-card">待更新</article>';
  const rows = responses.map((entry) => `
    <div class="response-row">
      <span class="response-value-cell">${escapeHtml(entry.visit || "未提供")}</span>
      <span class="response-value-cell">${escapeHtml(entry.targetResponse || "未提供")}</span>
      <span class="response-value-cell">${escapeHtml(entry.nonTargetResponse || "未提供")}</span>
      <span class="response-value-cell">${escapeHtml(entry.newLesion || "未提供")}</span>
      <span class="response-value-cell">${escapeHtml(entry.overallResponse || "未提供")}</span>
    </div>
  `).join("");
  return `
    <div class="response-table-wrap">
      <div class="response-table">
        <div class="response-row response-header-row">
          <span class="response-header-cell">肿评周期</span>
          <span class="response-header-cell">靶病灶结果</span>
          <span class="response-header-cell">非靶病灶结果</span>
          <span class="response-header-cell">新病灶</span>
          <span class="response-header-cell">疗效评价</span>
        </div>
        ${rows}
      </div>
    </div>
  `;
}

function renderCriticalHints(hints) {
  if (!hints.length) return '<p class="hero-hint-title">重点数据提示</p><p>当前未识别到需要优先核查的关键风险。</p>';
  return `
    <p class="hero-hint-title">重点数据提示</p>
    <div class="critical-hint-list">
      ${hints.map((hint) => `<p>${escapeHtml(hint)}</p>`).join("")}
    </div>
  `;
}

function renderLabModule(group) {
  const rows = group.items.map((item) => {
    const firstDefinedUnit  = item.entries.find((e) => e.unit)?.unit || "未提供";
    const firstDefinedRange = item.entries.find((e) => e.referenceRange)?.referenceRange || "未提供";
    const resultItems = item.entries.map((entry) => {
      const trendIcon = entry.abnormality === "high"
        ? '<span class="trend-icon high">↑</span>'
        : entry.abnormality === "low"
          ? '<span class="trend-icon low">↓</span>'
          : "";
      const note = formatSignificance(entry.significance);
      const noteBadge = note
        ? `<span class="result-note-badge ${note === "CS" ? "note-critical" : "note-ncs"}">${escapeHtml(note)}</span>`
        : "";
      const weightTitle = entry.weightAlert ? ' title="体重变化超过10%"' : "";
      return `
        <div class="result-chip ${entry.abnormality}${entry.weightAlert ? " weight-alert" : ""}"${weightTitle}>
          ${noteBadge}
          <span class="result-main">${trendIcon}<span>${escapeHtml(entry.result)}</span></span>
          <span class="result-date">${escapeHtml(formatResultDateLabel(entry))}</span>
        </div>
      `;
    }).join("");

    const itemSigFlags = item.entries.map((e) => formatSignificance(e.significance));
    const itemHasCS  = itemSigFlags.some((f) => f === "CS");
    const itemHasNCS = !itemHasCS && itemSigFlags.some((f) => f === "NCS");
    const itemSigBadge = itemHasCS
      ? '<span class="item-sig-badge note-critical">CS</span>'
      : itemHasNCS
        ? '<span class="item-sig-badge note-ncs">NCS</span>'
        : "";

    const trendClass = item.trend.available ? " lab-row-trendable" : "";
    const trendHint = item.trend.available ? '<span class="lab-trend-hint">点击查看趋势</span>' : "";
    const trendCanvas = item.trend.available
      ? '<div class="lab-trend-panel" hidden><canvas class="lab-trend-canvas" aria-label="检查项趋势图"></canvas></div>'
      : "";

    return `
      <div class="lab-row${trendClass}" data-lab-name="${escapeAttribute(item.name)}"${item.trend.available ? ' role="button" tabindex="0"' : ""}>
        <div class="lab-row-head">
          <h4>${escapeHtml(item.name)}${itemSigBadge}${trendHint}</h4>
          <div class="lab-meta-row">
            <span class="meta-pill">单位: ${escapeHtml(firstDefinedUnit)}</span>
            <span class="meta-pill">范围: ${escapeHtml(firstDefinedRange)}</span>
          </div>
        </div>
        <div class="result-stack">${resultItems}</div>
        ${trendCanvas}
      </div>
    `;
  }).join("");

  return `
    <details class="lab-module-card">
      <summary class="lab-module-summary">
        <div class="lab-summary-title">
          <h4>${escapeHtml(group.moduleName)}</h4>
          ${group.hasCritical ? '<span class="lab-critical-flag">存在具有临床意义的异常检查值</span>' : ""}
          <span class="lab-summary-arrow">▾</span>
        </div>
        <span class="badge">${group.items.length} 项</span>
      </summary>
      <div class="lab-module-body">${rows}</div>
    </details>
  `;
}

function bindLabTrendControls(patient) {
  elements.labsGrid.querySelectorAll(".lab-row-trendable").forEach((row) => {
    const item = patient.groupedLabs
      .flatMap((group) => group.items)
      .find((candidate) => candidate.name === row.dataset.labName);
    if (!item) return;

    const toggleTrend = () => {
      const panel = row.querySelector(".lab-trend-panel");
      const canvas = row.querySelector(".lab-trend-canvas");
      const isOpen = !panel.hidden;
      panel.hidden = isOpen;
      row.classList.toggle("trend-open", !isOpen);
      if (!isOpen) drawLabTrend(canvas, item.trend.points);
    };

    row.addEventListener("click", toggleTrend);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleTrend();
      }
    });
  });
}

function drawLabTrend(canvas, points) {
  const width = Math.max(canvas.parentElement.clientWidth, 320);
  const height = 230;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(Math.abs(max) * 0.1, 1);
  const padding = { top: 22, right: 20, bottom: 42, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index) => padding.left + index * plotWidth / (points.length - 1);
  const y = (value) => padding.top + (max - value) * plotHeight / range;

  context.strokeStyle = "#dbe4ee";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, height - padding.bottom);
  context.lineTo(width - padding.right, height - padding.bottom);
  context.stroke();

  context.strokeStyle = "#1769aa";
  context.lineWidth = 2;
  context.beginPath();
  points.forEach((point, index) => {
    const pointX = x(index);
    const pointY = y(point.value);
    if (index === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  });
  context.stroke();

  context.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
  points.forEach((point, index) => {
    const pointX = x(index);
    const pointY = y(point.value);
    context.fillStyle = "#1769aa";
    context.beginPath();
    context.arc(pointX, pointY, 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#475569";
    context.textAlign = index === 0 ? "left" : index === points.length - 1 ? "right" : "center";
    context.fillText(point.date || "未提供", pointX, height - 18);
    context.fillText(String(point.value), pointX, pointY - 9);
  });
}

function openLabAeWindow(patient, linkedRecords) {
  const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const toNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : Number.NaN;
  const visits = (patient.dummy_sv || []).map((visit) => ({
    name: String(visit.visitName || ""),
    start: toNumber(visit.startSortableDate),
    end: toNumber(visit.endSortableDate),
  })).filter((visit) => visit.name && Number.isFinite(visit.start) && Number.isFinite(visit.end));
  const positiveLabs = linkedRecords.map((record) => record.build_ctc_out || {});
  const positiveTests = new Set(positiveLabs.map((lab) => String(lab.LBTEST_CN || "")).filter(Boolean));
  const allLabs = (patient.labae_out || []).filter((lab) => positiveTests.has(String(lab.LBTEST_CN || lab["HRSTD LBTEST-CN"] || "")));
  const rows = allLabs.map((lab) => {
    const record = linkedRecords.find((item) => {
      const linkedLab = item.build_ctc_out || {};
      return String(linkedLab.LBTEST_CN || "") === String(lab.LBTEST_CN || "") &&
        String(linkedLab.collectionDate || "") === String(lab.collectionDate || "");
    }) || linkedRecords.find((item) => String(item.build_ctc_out?.LBTEST_CN || "") === String(lab.LBTEST_CN || ""));
    const ae = record?.ae_normalized || {};
    const start = toNumber(lab.LABAE_ST_GRP && Date.parse(lab.LABAE_ST_GRP)) || toNumber(lab.sortableDate);
    const visit = visits.find((item) => item.name === String(lab["访视名称_NEW_LB"] || lab.visitLabel || ""));
    const unresolved = String(lab.LABAE_OUT || "").includes("未恢复/未解决");
    const visitEnd = visit?.end;
    const endValue = unresolved && Number.isFinite(visitEnd)
      ? visitEnd
      : (toNumber(lab.LABAE_EN_GRP && Date.parse(lab.LABAE_EN_GRP)) || toNumber(lab.sortableDate));
    return {
      lab,
      ae,
      start: Number.isFinite(start) ? start : Number.NaN,
      end: Number.isFinite(endValue) ? Math.max(endValue, start) : start,
      point: toNumber(lab.sortableDate),
      visit: String(lab["访视名称_NEW_LB"] || lab.visitLabel || "未标注"),
      test: String(lab.LBTEST_CN || lab["HRSTD LBTEST-CN"] || ""),
      toxicity: String(lab.LBTOXCN || ""),
      isLabAe: Number.parseInt(String(lab.LABAE_GRD || "").replace(/[^0-9]/g, ""), 10) >= 1,
      isOngoing: unresolved,
      inferredEnd: unresolved && Number.isFinite(visitEnd),
    };
  }).filter((row) => row.test && Number.isFinite(row.point) && Number.isFinite(row.start));
  const maxSvEnd = (visitName) => {
    const matched = visits.filter((visit) => visit.name === String(visitName || ""));
    return matched.reduce((max, visit) => Math.max(max, visit.end), Number.NaN);
  };
  const timelineRows = [];
  (patient.ae_normalized || []).forEach((ae) => {
    const name = String(ae.PT_CN || ae.ptCn || ae.LLT_CN || ae.lltCn || ae.name || "").trim();
    const originalTerm = String(ae.name || "").trim();
    const start = toNumber(ae.sortableDate);
    if (!name || !originalTerm || !Number.isFinite(start)) return;
    const ongoing = Boolean(ae.ong) || !Number.isFinite(toNumber(ae.endSortableDate));
    const end = ongoing ? Number.NaN : toNumber(ae.endSortableDate);
    timelineRows.push({
      source: "EDC AE",
      name,
      originalTerm,
      start,
      end,
      ongoing,
      grade: String(ae.grade || ""),
      outcome: String(ae.outcome || ""),
      outcomeDate: String(ae.outcomeDate || ""),
      raw: ae,
    });
  });
  linkedRecords.forEach((record) => {
    const lab = record.build_ctc_out || {};
    const ae = record.ae_normalized || {};
    const grade = Number.parseInt(String(lab.LABAE_GRD || "").replace(/[^0-9]/g, ""), 10) || 0;
    const name = String(ae.PT_CN || ae.ptCn || ae.LLT_CN || ae.lltCn || ae.name || lab.LBTOXCN || "").trim();
    const start = toNumber(lab.sortableDate);
    if (!name || !Number.isFinite(start) || grade < 1) return;
    const ongoing = String(lab.LABAE_OUT || "").includes("未恢复/未解决");
    const visitName = String(lab["访视名称_NEW_LB"] || lab.visitLabel || "");
    const visitEnd = maxSvEnd(visitName);
    const explicitEnd = toNumber(lab.LABAE_EN_GRP && Date.parse(lab.LABAE_EN_GRP));
    const end = ongoing ? visitEnd : explicitEnd;
    timelineRows.push({
      source: "LAB AE",
      name,
      originalTerm: String(ae.name || lab.name || lab["检查项"] || "").trim(),
      start,
      end,
      ongoing,
      grade: String(lab.LABAE_GRD || ""),
      outcome: String(lab.LABAE_OUT || ""),
      outcomeDate: String(lab.LABAE_EN_GRP || ""),
      visit: visitName,
      raw: lab,
    });
  });

  const payload = JSON.stringify({
    patientId: patient.patientId,
    rows,
    visits,
    timelineRows,
  }).replace(/</g, "\\u003c");
  const labGradeLegend = [...new Set(rows
    .filter((row) => row.isLabAe)
    .map((row) => Number.parseInt(String(row.lab.LABAE_GRD || "").replace(/[^0-9]/g, ""), 10))
    .filter((grade) => grade >= 1 && grade <= 5))]
    .sort((a, b) => a - b)
    .map((grade) => {
      const colors = {
        1: ["#facc15", "#a16207"],
        2: ["#fbbf24", "#b45309"],
        3: ["#fb923c", "#c2410c"],
        4: ["#f87171", "#b91c1c"],
        5: ["#ef4444", "#991b1b"],
      }[grade];
      return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><i style="display:inline-block;width:28px;height:12px;background:${colors[0]};border:1px solid ${colors[1]};border-radius:3px"></i>Grade ${grade}</span>`;
    })
    .join("");
  const css = `*{box-sizing:border-box}body{margin:0;padding:18px;background:#f8fafc;color:#1e293b;font:13px system-ui,-apple-system,"Microsoft YaHei",sans-serif}h1{margin:0 0 8px;color:#1e3a5f;font-size:1.25rem}.meta{color:#64748b;margin-bottom:14px}.card{padding:14px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 1px 4px rgba(15,23,42,.08)}.chart-scroll{max-width:100%;max-height:70vh;overflow:auto;border:1px solid #f1f5f9}#chart{overflow:visible}.chart{position:relative;min-width:1100px;width:1100px;height:450px}.axis{position:absolute;left:190px;right:18px;top:22px;height:1px;background:#94a3b8}.row-label{position:absolute;left:0;width:180px;font-weight:700;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row-line{position:absolute;left:190px;right:18px;height:1px;background:#e2e8f0}.bar{position:absolute;height:16px;padding:0 5px;border-radius:8px;background:#fbbf24;border:1px solid #d97706;cursor:pointer;color:#78350f;font-size:10px;font-weight:700;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar.ongoing{border-style:dashed;background:#fef3c7}.bar:hover{background:#f59e0b}.point{position:absolute;width:8px;height:8px;margin:-4px;border-radius:50%;background:#237a63;border:1px solid #166534;cursor:pointer}.tick{position:absolute;top:396px;color:#64748b;font-size:10px;transform:translateX(-50%);white-space:nowrap}.visit-tick{position:absolute;top:414px;color:#1e3a5f;font-size:11px;font-weight:700;transform:translateX(-50%);white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;text-align:center}.legend{margin-top:10px;color:#475569;font-size:12px}.timeline-title{margin:0 0 8px;color:#1e3a5f;font-size:1.25rem;font-weight:700}.timeline-card{overflow:hidden}.timeline-scroll{max-width:100%;max-height:70vh;overflow:auto;border:1px solid #f1f5f9}.timeline-legend{margin-top:6px;color:#475569;font-size:12px}.legend-edc{color:#1976d2}.legend-lab{color:#d66a43}.tip{position:fixed;display:none;z-index:3;max-width:360px;padding:10px 12px;background:#0f172a;color:#f8fafc;border-radius:6px;line-height:1.55;box-shadow:0 5px 18px rgba(15,23,42,.25);pointer-events:none}.tip b{color:#fbbf24}`;
  const script = `(function(){
const data=JSON.parse(document.getElementById('labAeData').textContent), chart=document.getElementById('chart'), tip=document.getElementById('tip');chart.parentElement.style.overflowX='scroll';
const rows=data.rows, visits=data.visits||[], dates=rows.flatMap(r=>[r.start,r.end,r.point]).filter(Number.isFinite);
const min=Math.min.apply(null,dates), max=Math.max.apply(null,dates.concat(visits.flatMap(v=>[v.start,v.end]))), span=Math.max(max-min,86400000), left=190, right=18, width=Math.max(1600,Math.min(2600,1600+span/86400000*2))-left-right;
const tests=[...new Set(rows.map(r=>r.test))], esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),labGradeColors={1:{fill:'#facc15',stroke:'#a16207'},2:{fill:'#fbbf24',stroke:'#b45309'},3:{fill:'#fb923c',stroke:'#c2410c'},4:{fill:'#f87171',stroke:'#b91c1c'},5:{fill:'#ef4444',stroke:'#991b1b'}};
function x(v){return left+(v-min)/span*width}chart.style.width=(width+left+right)+'px';
const drugFields=[['盲态药物A','对HRS-8080采取措施','与HRS-8080的关系'],['盲态药物B','对来曲唑采取措施','与来曲唑的关系'],['盲态药物C','对阿那曲唑采取措施','与阿那曲唑的关系'],['盲态药物D','对依西美坦采取措施','与依西美坦的关系'],['盲态药物E','对他莫昔芬采取措施','与他莫昔芬的关系']];
function drugInfo(a){return drugFields.map(([label,action,relation])=>{const actionValue=String(a[action]??'').trim(),relationValue=String(a[relation]??'').trim();return (actionValue?'<br>'+label+'采取措施：'+esc(actionValue): '')+(relationValue?'<br>'+label+'关系：'+esc(relationValue):'');}).join('');}
function show(event,row){const l=row.lab,a=row.ae,line=(label,value)=>{const text=String(value??'').trim();return text?'<br>'+label+'：'+esc(text):'';};tip.innerHTML='<b>'+esc(row.toxicity||row.test)+'</b>'+line('参与者代码',l['参与者代码']||data.patientId)+line('检查项',l.LBTEST_CN||row.test)+line('LB数值',l.result)+line('单位',l.unit)+line('标准单位',l.standardUnit)+line('标准下限',l.standardLow)+line('标准上限',l.standardHigh)+line('临床意义',l.significance)+line('访视',row.visit)+line('AE名称',a.name)+line('AE开始时间',a.startDate)+line('AE结束时间',a.outcomeDate)+line('AE转归',a.outcome)+line('AE等级',a.grade)+line('是否为SAE',a.isSae)+line('LABAE_OUT',l.LABAE_OUT)+drugInfo(a);tip.style.display='block';tip.style.left=Math.min(event.clientX+12,window.innerWidth-380)+'px';tip.style.top=Math.min(event.clientY+12,window.innerHeight-300)+'px';}
function hide(){tip.style.display='none';}
tests.forEach((test,i)=>{const y=42+i*34,label=document.createElement('div');label.className='row-label';label.style.top=(y-8)+'px';label.textContent=test;chart.appendChild(label);const line=document.createElement('div');line.className='row-line';line.style.top=y+'px';chart.appendChild(line);rows.filter(r=>r.test===test).forEach(r=>{if(r.isLabAe){const bar=document.createElement('div'),grade=Number.parseInt(String(r.lab.LABAE_GRD||'').replace(/[^0-9]/g,''),10)||0,gradeStyle=labGradeColors[grade]||labGradeColors[1];const gradeLabel=document.createElement('div');gradeLabel.style.position='absolute';gradeLabel.style.left=x(r.start)+'px';gradeLabel.style.top=(y-24)+'px';gradeLabel.style.color=gradeStyle.stroke;gradeLabel.style.fontWeight='700';gradeLabel.style.fontSize='10px';gradeLabel.textContent='Grade '+grade;chart.appendChild(gradeLabel);bar.className='bar'+(r.isOngoing?' ongoing':'');bar.style.left=x(r.start)+'px';bar.style.top=(y-8)+'px';bar.style.width=Math.max(8,x(r.end)-x(r.start))+'px';bar.style.background=gradeStyle.fill;bar.style.borderColor=gradeStyle.stroke;bar.textContent=r.inferredEnd?'LABAE_推断=Ongoing':'';bar.title='Grade '+grade+(r.inferredEnd?' · LABAE_推断=Ongoing':'');bar.addEventListener('mousemove',e=>show(e,r));bar.addEventListener('mouseleave',hide);chart.appendChild(bar);}const point=document.createElement('div');point.className='point';point.style.left=x(r.point)+'px';point.style.top=y+'px';point.addEventListener('mousemove',e=>show(e,r));point.addEventListener('mouseleave',hide);chart.appendChild(point);});});
const visitPositions=new Map();rows.forEach(row=>{if(!visitPositions.has(row.visit))visitPositions.set(row.visit,[]);visitPositions.get(row.visit).push(row.point);});
[...visitPositions.entries()].forEach(([name,points])=>{const visitTick=document.createElement('div');visitTick.className='visit-tick';visitTick.style.left=x(points.reduce((sum,value)=>sum+value,0)/points.length)+'px';visitTick.textContent=name;visitTick.title=name;chart.appendChild(visitTick);});
})();`;
  const timelineScript = `(function(){
const data=JSON.parse(document.getElementById('labAeData').textContent), chart=document.getElementById('timelineChart');chart.parentElement.style.overflowX='scroll';
if(!chart)return;
const sourceRows=data.timelineRows||[], esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
if(!sourceRows.length){chart.innerHTML='<div style="color:#94a3b8;padding:12px">暂无可展示的 EDC AE 或 LAB AE 时间数据</div>';return;}
const DAY=86400000, shortEnd=(r)=>r.ongoing&&r.source==='EDC AE'?r.start+14*DAY:(Number.isFinite(r.end)?r.end:r.start);
const groups=new Map();sourceRows.forEach((r,index)=>{const key=r.source+'|'+r.name;if(!groups.has(key))groups.set(key,{source:r.source,name:r.name,segments:[]});groups.get(key).segments.push({...r,sourceIndex:index,end:shortEnd(r)});});
const groupRows=[...groups.values()].sort((a,b)=>a.segments[0].start-b.segments[0].start||a.source.localeCompare(b.source));
const dates=sourceRows.flatMap(r=>[r.start,shortEnd(r)]).filter(Number.isFinite), min=Math.min(...dates), max=Math.max(...dates), span=Math.max(max-min,DAY), LP=215,RP=70,TP=30,RH=32,RG=5,W=Math.max(1600,Math.min(2800,1600+span/DAY*2)),BW=W-LP-RP,H=TP+groupRows.length*(RH+RG)+36;
const x=v=>LP+(v-min)/span*BW, fmt=v=>new Date(v).toISOString().slice(0,10), color={"EDC AE":{fill:'#90caf9',stroke:'#1976d2'},"LAB AE":{fill:'#ffb38f',stroke:'#d66a43'}};
const ticks=[];const count=Math.max(2,Math.min(8,Math.floor(BW/130)));for(let i=0;i<=count;i++)ticks.push(min+(max-min)*i/count);
let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+W+' '+H+'" style="display:block;width:100%;min-width:900px">';svg+='<rect width="100%" height="100%" fill="#fffdf8"/>';
ticks.forEach(t=>{const xx=x(t).toFixed(1);svg+='<line x1="'+xx+'" y1="24" x2="'+xx+'" y2="'+(H-28)+'" stroke="#e5e7eb"/><text x="'+xx+'" y="19" text-anchor="middle" font-size="10" fill="#2563a5">'+fmt(t)+'</text>';});
groupRows.forEach((g,i)=>{const y=TP+i*(RH+RG), c=color[g.source]||color['EDC AE'];svg+='<line x1="'+LP+'" y1="'+(y+RH+2)+'" x2="'+(W-RP)+'" y2="'+(y+RH+2)+'" stroke="#e5e7eb"/>';svg+='<text x="14" y="'+(y+13)+'" font-size="10" font-weight="700" fill="#0f172a">'+esc(g.source)+'</text><text x="14" y="'+(y+26)+'" font-size="10" fill="#0f172a">'+esc(g.name)+'</text>';
g.segments.forEach(r=>{const sx=x(r.start),ex=Math.max(sx+6,x(r.end)),ongoing=r.ongoing,gradeNumber=String(r.grade||'').match(/[1-5]/)?.[0]||'';svg+='<g class="timeline-segment" data-timeline-index="'+r.sourceIndex+'">'+(gradeNumber?'<text x="'+sx.toFixed(1)+'" y="'+(y+6)+'" text-anchor="start" font-size="10" font-weight="700" fill="'+c.stroke+'">Grade '+gradeNumber+'</text>':'')+'<rect x="'+sx.toFixed(1)+'" y="'+(y+9)+'" width="'+(ex-sx).toFixed(1)+'" height="16" rx="3" fill="'+c.fill+'" stroke="'+c.stroke+'"'+(ongoing?' stroke-dasharray="5,3"':'')+'/></g>';});});
svg+='</svg>';chart.innerHTML=svg+'<div class="timeline-legend"><span class="legend-edc">■</span> EDC AE　<span class="legend-lab">■</span> LAB AE　虚线：未结束 EDC AE 短延伸</div>';chart.querySelector('svg').style.width=W+'px';
const tip=document.getElementById('tip');const line=(label,value)=>value?'<br>'+label+'：'+esc(value):'';
chart.querySelectorAll('.timeline-segment').forEach(segment=>{segment.addEventListener('mousemove',event=>{const r=sourceRows[Number(segment.dataset.timelineIndex)],end=shortEnd(r);tip.innerHTML='<b>'+esc(r.source+' · '+r.name)+'</b>'+line('开始日期',fmt(r.start))+line('结束日期',r.ongoing?(r.source==='LAB AE'?fmt(end):'未结束（短虚线延伸）'):fmt(end))+line('等级',r.grade)+line('转归',r.outcome)+line('原始术语',r.originalTerm)+line('访视',r.visit)+line('LABAE_OUT',r.source==='LAB AE'?r.outcome:'');tip.style.display='block';tip.style.left=Math.min(event.clientX+14,window.innerWidth-380)+'px';tip.style.top=Math.min(event.clientY+14,window.innerHeight-260)+'px';});segment.addEventListener('mouseleave',()=>{tip.style.display='none';});});})();`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Lab-AE — ${esc(patient.patientId)}</title><style>${css}</style></head><body><h1>Lab-AE（实验室推导结果展示）— ${esc(patient.patientId)}</h1><div class="meta">共 ${rows.length} 条关联记录；仅显示 LBTEST_CN 非空且 LABAE_GRD ≥ Grade 1 的记录</div><div class="card"><div class="chart-scroll"><div id="chart" class="chart"></div></div><div class="legend">● 实验室检查结果　<span style="color:#d97706">━</span> Lab-AE横条（显示对应 LABAE_GRD；LABAE_ST_GRP 至 LABAE_EN_GRP；未恢复/未解决时虚线延长至该访视 max_dtc，并标记 LABAE_推断=Ongoing）</div><div class="lab-grade-legend"><span>Lab-AE等级：</span>${labGradeLegend}</div></div><div class="card timeline-card"><h1 class="timeline-title">AE标准化浏览（EDC AE V.S. Lab-AE）</h1><div class="timeline-scroll"><div id="timelineChart"></div></div></div><div id="tip" class="tip"></div><script type="application/json" id="labAeData">${payload}</script><script>${script}<\/script><script>${timelineScript}<\/script></body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  window.setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function openCmWindow(patient) {
  const list = patient.cmList.slice().sort((a, b) => a.sortableDate - b.sortableDate);
  const ongoingCount = list.filter((cm) => cm.ongoing === "是").length;
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const endCell = (cm) => {
    if (cm.ongoing === "是") return `<span class="ongoing">持续中</span>`;
    return cm.endDate && cm.endDate !== "未提供" ? esc(cm.endDate) : "—";
  };
  const rows = list.map((cm, i) =>
    `<tr class="${cm.ongoing === "是" ? "rc-on" : ""}">`+
    `<td>${esc(cm.seqNum) || (i + 1)}</td>`+
    `<td><strong>${esc(cm.name)}</strong></td>`+
    `<td>${esc(cm.dose) || "—"}</td>`+
    `<td>${esc(cm.form) || "—"}</td>`+
    `<td>${esc(cm.route) || "—"}</td>`+
    `<td>${esc(cm.freq) || "—"}</td>`+
    `<td>${esc(cm.startDate)}</td>`+
    `<td>${endCell(cm)}</td>`+
    `<td>${esc(cm.reason) || "—"}</td>`+
    `<td>${esc(cm.relMh) || "—"}</td>`+
    `<td>${esc(cm.relAe) || "—"}</td></tr>`
  ).join("");
  const badges = ongoingCount > 0 ? `<span class="sb sg">持续中：${ongoingCount} 条</span>` : "";
  const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;font-size:13px;background:#f8fafc;color:#1e293b;padding:24px}
header{margin-bottom:20px}h1{font-size:1.3rem;font-weight:700;color:#1e3a5f;margin-bottom:8px}
.meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:.82rem;color:#64748b}
.sb{display:inline-block;padding:2px 9px;border-radius:9999px;font-weight:600;font-size:.78rem}.sg{background:#dcfce7;color:#166534}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
thead{background:#1e3a5f;color:#fff}th{padding:10px 12px;text-align:left;font-size:.75rem;font-weight:600;white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:.82rem}
tr:last-child td{border-bottom:none}tbody tr:hover td{background:#f1f5f9!important}
.rc-on td{background:#f0fdf4}
.ongoing{display:inline-block;padding:1px 7px;border-radius:4px;font-size:.78rem;font-weight:600;background:#dcfce7;color:#166534}
td strong{font-weight:600}`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>合并用药 — ${esc(patient.patientId)}</title>\n<style>${css}</style></head>\n<body><header>\n  <h1>既往及合并用药 — ${esc(patient.patientId)}</h1>\n  <div class="meta"><span>共 <strong>${list.length}</strong> 条</span>${badges ? " " + badges : ""}</div>\n</header>\n<table>\n  <thead><tr><th>序号</th><th>药物名称</th><th>剂量</th><th>剂型</th><th>途径</th><th>频率</th><th>开始日期</th><th>结束/状态</th><th>用药原因</th><th>相关既往史</th><th>相关AE</th></tr></thead>\n  <tbody>${rows}</tbody>\n</table></body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  window.setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function openAeWindow(patient) {
  if (aePopupWindow && !aePopupWindow.closed) aePopupWindow.close();
  const list = patient.aeList.slice().sort((a, b) => a.sortableDate - b.sortableDate);
  const drugDisplay = [
    { name: 'HRS-8080', label: '盲态药物A', action: '对HRS-8080采取措施', rel: '与HRS-8080的关系' },
    { name: '来曲唑', label: '盲态药物B', action: '对来曲唑采取措施', rel: '与来曲唑的关系' },
    { name: '阿那曲唑', label: '盲态药物C', action: '对阿那曲唑采取措施', rel: '与阿那曲唑的关系' },
    { name: '依西美坦', label: '盲态药物D', action: '对依西美坦采取措施', rel: '与依西美坦的关系' },
    { name: '他莫昔芬', label: '盲态药物E', action: '对他莫昔芬采取措施', rel: '与他莫昔芬的关系' },
  ];
  const toN = (g) => parseInt(g, 10) || 0;
  const highGrade = list.filter((ae) => toN(ae.grade) >= 3).length;
  const saeCount  = list.filter((ae) => ae.isSae === "是").length;
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const gradeTag = (g) => {
    if (!g) return "—";
    const n = toN(g);
    const cls = n >= 4 ? "g45" : n >= 3 ? "g3" : "g12";
    return `<span class="gr ${cls}">${esc(g)}</span>`;
  };
  const rows = list.map((ae, i) => {
    const n  = toN(ae.grade);
    const rc = n >= 4 ? "rd" : n >= 3 ? "rw" : ae.isSae === "是" ? "rs" : "";
    const tags = (ae.isSae === "是" ? `<span class="t ts">SAE</span>` : "")
               + (ae.isAesi === "是" ? `<span class="t ta">AESI</span>` : "");
    const drugCell = drugDisplay.map((drug) => {
      const parts = [ae[drug.action], ae[drug.rel]].filter(Boolean);
      if (!parts.length) return '';
      const label = state.blindMode ? drug.label : drug.name;
      return `<span class="dr">${esc(label)}</span>（${parts.map(esc).join('，')}）`;
    }).filter(Boolean).join('<br>') || '—';
    const od = ae.outcomeDate && ae.outcomeDate !== "未提供" ? esc(ae.outcomeDate) : "—";
    return `<tr class="${rc}"><td>${esc(ae.seqNum) || (i + 1)}</td>` +
           `<td><strong>${esc(ae.name)}</strong>${tags}</td>` +
          `<td>${esc(ae.lltCn)}</td><td>${esc(ae.ptCn)}</td><td>${esc(ae.ptCode)}</td><td>${esc(ae.socCn)}</td>` +
           `<td>${gradeTag(ae.grade)}</td><td>${esc(ae.startDate)}</td>` +
           `<td>${esc(ae.outcome) || "—"}</td><td>${od}</td>` +
           `<td>${esc(ae.hasCorrect) || "—"}</td><td>${drugCell}</td></tr>`;
  }).join("");
  const badges = [
    highGrade > 0 ? `<span class="sb sw">Grade ≥3：${highGrade} 条</span>` : "",
    saeCount  > 0 ? `<span class="sb sd">SAE：${saeCount} 条</span>` : "",
  ].filter(Boolean).join(" ");

  const M9 = Number.MAX_SAFE_INTEGER;
  const jsonData = JSON.stringify({
    aes: list.map(ae => ({
      name: ae.name, grade: ae.grade, isSae: ae.isSae === '是',
      ong: ae.ong !== undefined ? ae.ong : (!ae.outcomeDate || ae.outcomeDate === '未提供' || ae.outcome === '持续中'),
      st: ae.sortableDate < M9 ? ae.sortableDate : 0,
      et: ae.endSortableDate && ae.endSortableDate < M9 ? ae.endSortableDate : 0,
    })),
    visits: [],
    drugAdmins: (patient.drugAdmins || []),
  });

  const clientScript = `(function(){
var data=JSON.parse(document.getElementById('aeData').textContent);
var ct=document.getElementById('tChart');
if(!ct)return;
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderTimeline(){
  var raw=data.aes,drugAdmins=data.drugAdmins||[];
  if(!raw||!raw.length){ct.innerHTML='<div style="color:#94a3b8;padding:12px">暂无 AE 数据</div>';return;}
  var M=Date.now()+86400000*3;
  var M9=Number.MAX_SAFE_INTEGER;
  var activeDrugAdmins=drugAdmins.filter(function(d){return d.sortableDate<M;});
  var hasDrugs=activeDrugAdmins.length>0;
  var DRUG_CFG=[
    {name:'HRS-8080',color:'#16a34a',short:'8080'},
    {name:'来曲唑',  color:'#2563eb',short:'来曲唑'},
    {name:'阿那曲唑',color:'#7c3aed',short:'阿那曲唑'},
    {name:'依西美坦',color:'#ea580c',short:'依西美坦'},
    {name:'他莫昔芬',color:'#db2777',short:'他莫昔芬'},
  ];
  var activeDrugTypes=hasDrugs?DRUG_CFG.filter(function(cfg){return activeDrugAdmins.some(function(d){return d.drug===cfg.name;});}):[];
  var gC={1:'#bfdbfe',2:'#93c5fd',3:'#fca5a5',4:'#f87171',5:'#ef4444'};
  var gD={1:'#1e40af',2:'#1d4ed8',3:'#991b1b',4:'#7f1d1d',5:'#450a0a'};
  var gc={};
  raw.forEach(function(ae){var g=parseInt(ae.grade,10)||0;if(g)gc[g]=(gc[g]||0)+1;});
  // group AEs by name
  var grpMap={};
  raw.forEach(function(ae){
    if(!ae.st)return;
    if(!grpMap[ae.name])grpMap[ae.name]={name:ae.name,aes:[],minSt:M};
    grpMap[ae.name].aes.push(ae);
    if(ae.st<grpMap[ae.name].minSt)grpMap[ae.name].minSt=ae.st;
  });
  var grpRows=Object.values(grpMap).sort(function(a,b){return a.minSt-b.minSt;});
  // timeline range
  var allTs=[];
  raw.forEach(function(ae){if(ae.st)allTs.push(ae.st);if(ae.et&&!ae.ong)allTs.push(ae.et);});
  activeDrugAdmins.forEach(function(d){allTs.push(d.sortableDate);if(d.endSortableDate&&d.endSortableDate<M)allTs.push(d.endSortableDate);});
  if(!allTs.length){ct.innerHTML='<div style="color:#94a3b8;padding:12px">暂无时间数据</div>';return;}
  var minT=Math.min.apply(null,allTs)-7*86400000;
  var maxT=Math.max.apply(null,allTs)+7*86400000;
  var rng=maxT-minT;
  if(rng<=0)rng=86400000*30;
  // layout
  var N=grpRows.length,LP=215,RP=18,TP=8,RH=22,RG=4,W=800,BW=W-LP-RP;
  var BAND_H=10,BAND_GAP=2,LEG_H=22;
  var BP=hasDrugs?(14+activeDrugTypes.length*(BAND_H+BAND_GAP)+LEG_H):26;
  BP=Math.max(BP,26);
  var H=TP+N*(RH+RG)+BP;
  var tdAll=Math.ceil(rng/86400000),ti=tdAll<=30?7:tdAll<=90?14:tdAll<=180?21:tdAll<=365?30:60;
  var dateTicks=[];
  for(var d=0;d<=tdAll;d+=ti){var dt=new Date(minT+d*86400000);dateTicks.push({ts:minT+d*86400000,label:String(dt.getFullYear())+'/'+String(dt.getMonth()+1).padStart(2,'0')+'/'+String(dt.getDate()).padStart(2,'0')});}
  var s=[];
  s.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+W+' '+H+'" style="display:block;width:100%;overflow:visible">');
  s.push('<rect width="'+W+'" height="'+H+'" fill="#f8fafc"/>');
  s.push('<rect x="'+LP+'" y="'+TP+'" width="'+BW+'" height="'+(H-TP-BP)+'" fill="#fff" rx="3" stroke="#e2e8f0" stroke-width="1"/>');
  // alternating bands
  grpRows.forEach(function(row,i){if(i%2===0){var y=TP+i*(RH+RG);s.push('<rect x="'+LP+'" y="'+y+'" width="'+BW+'" height="'+RH+'" fill="#f8fafc"/>');}});
  // grid + date labels
  dateTicks.forEach(function(tick){
    var x=(LP+(tick.ts-minT)/rng*BW).toFixed(1);
    s.push('<line x1="'+x+'" y1="'+TP+'" x2="'+x+'" y2="'+(H-BP)+'" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3,3"/>');
    s.push('<text x="'+x+'" y="'+(H-BP+11)+'" text-anchor="middle" font-size="7" fill="#94a3b8">'+esc(tick.label)+'</text>');
  });
  // AE rows
  grpRows.forEach(function(row,i){
    var y=TP+i*(RH+RG);
    var rawNm=row.name||'?';
    var L1,L2;
    if(rawNm.length<=20){L1=rawNm;L2=null;}
    else{var sp=rawNm.lastIndexOf(' ',20);var cut=(sp>6)?sp:20;L1=rawNm.slice(0,cut).replace(/\s+$/,'');L2=rawNm.slice(cut).replace(/^\s+/,'');if(L2.length>22)L2=L2.slice(0,21)+'\u2026';}
    if(L2){
      s.push('<text x="'+(LP-5)+'" y="'+(y+RH*0.40).toFixed(1)+'" text-anchor="end" font-size="8" fill="#334155">'+esc(L1)+'</text>');
      s.push('<text x="'+(LP-5)+'" y="'+(y+RH*0.82).toFixed(1)+'" text-anchor="end" font-size="8" fill="#475569">'+esc(L2)+'</text>');
    }else{
      s.push('<text x="'+(LP-5)+'" y="'+(y+RH*0.65).toFixed(1)+'" text-anchor="end" font-size="9" fill="#334155">'+esc(L1)+'</text>');
    }
    row.aes.forEach(function(ae){
      if(!ae.st)return;
      var gr=parseInt(ae.grade,10)||0,fc=gC[gr]||'#cbd5e1',tc=gD[gr]||'#475569';
      var sx=LP+(ae.st-minT)/rng*BW,ex=ae.et&&!ae.ong?LP+Math.min((ae.et-minT)/rng,1)*BW:LP+BW,bw=Math.max(ex-sx,5);
      var xtra=ae.ong?' stroke="'+tc+'" stroke-width="1" stroke-dasharray="3,2" fill-opacity="0.68"':'';
      s.push('<rect x="'+sx.toFixed(1)+'" y="'+(y+2)+'" width="'+bw.toFixed(1)+'" height="'+(RH-4)+'" rx="2" fill="'+fc+'"'+xtra+'/>');
      if(bw>14&&gr>0)s.push('<text x="'+(sx+bw/2).toFixed(1)+'" y="'+(y+RH*0.65).toFixed(1)+'" text-anchor="middle" font-size="7.5" font-weight="700" fill="'+tc+'">G'+ae.grade+'</text>');
      if(ae.isSae){var dx=sx+4.5,dy=y+RH/2;s.push('<polygon points="'+dx.toFixed(1)+','+(dy-3)+' '+(dx+3).toFixed(1)+','+dy.toFixed(1)+' '+dx.toFixed(1)+','+(dy+3)+' '+(dx-3).toFixed(1)+','+dy.toFixed(1)+'" fill="#dc2626"/>');} 
      if(ae.ong){var ax=LP+BW-2,ay=y+RH/2;s.push('<polygon points="'+ax+','+(ay-3)+' '+(ax+5)+','+ay+' '+ax+','+(ay+3)+'" fill="'+tc+'" opacity="0.5"/>');} 
    });
    if(row.aes.every(function(ae){return !ae.st;})){s.push('<rect x="'+LP+'" y="'+(y+5)+'" width="20" height="'+(RH-10)+'" rx="2" fill="#e2e8f0"/>');} 
  });
  // axis lines
  s.push('<line x1="'+LP+'" y1="'+(H-BP)+'" x2="'+(LP+BW)+'" y2="'+(H-BP)+'" stroke="#94a3b8" stroke-width="1.5"/>');
  s.push('<line x1="'+LP+'" y1="'+TP+'" x2="'+LP+'" y2="'+(H-BP)+'" stroke="#cbd5e1" stroke-width="1"/>');
  // Drug treatment bands
  if(hasDrugs){
    activeDrugTypes.forEach(function(cfg,drugIdx){
      var bandY=H-BP+14+drugIdx*(BAND_H+BAND_GAP);
      // drug label on left
      s.push('<text x="'+(LP-3)+'" y="'+(bandY+BAND_H*0.75)+'" text-anchor="end" font-size="8" fill="'+cfg.color+'" font-weight="600">'+esc(cfg.short)+'</text>');
      // background track
      s.push('<rect x="'+LP+'" y="'+bandY+'" width="'+BW+'" height="'+BAND_H+'" rx="2" fill="'+cfg.color+'" fill-opacity="0.05" stroke="'+cfg.color+'" stroke-width="0.3" stroke-opacity="0.3"/>');
      // each period for this drug
      activeDrugAdmins.filter(function(da){return da.drug===cfg.name;}).forEach(function(da){
        var x1=LP+(da.sortableDate-minT)/rng*BW;
        var endTs=(da.endSortableDate&&da.endSortableDate<M9)?da.endSortableDate:M;
        var x2=LP+(endTs-minT)/rng*BW;
        x1=Math.max(LP,Math.min(LP+BW,x1));
        x2=Math.max(LP,Math.min(LP+BW,x2));
        var bw2=Math.max(x2-x1,4);
        var fc2=da.doseAdjusted?'#fde68a':cfg.color;
        var sc2=da.doseAdjusted?'#b45309':cfg.color;
        var dl=da.doseLevel?' ('+esc(da.doseLevel)+')':'';
        var endLabel=da.endDate&&da.endDate!=='未提供'?esc(da.endDate):'持续中';
        var tt=esc(da.drug)+(da.visit?' '+esc(da.visit):'')+dl+' | '+esc(da.date)+' → '+endLabel+(da.doseAdjusted?' [\u5242\u91cf\u8c03\u6574]':'');
        s.push('<g><title>'+tt+'</title>');
        s.push('<rect x="'+x1.toFixed(1)+'" y="'+bandY+'" width="'+bw2.toFixed(1)+'" height="'+BAND_H+'" rx="2" fill="'+fc2+'" fill-opacity="'+(da.doseAdjusted?0.55:0.35)+'" stroke="'+sc2+'" stroke-width="'+(da.doseAdjusted?1.5:0.8)+'"/>');
        // start tick
        s.push('<line x1="'+x1.toFixed(1)+'" y1="'+bandY+'" x2="'+x1.toFixed(1)+'" y2="'+(bandY+BAND_H)+'" stroke="'+sc2+'" stroke-width="2"/>');
        s.push('</g>');
      });
    });
    // Legend
    var legY=H-LEG_H+12,lx=LP;
    s.push('<text x="'+lx+'" y="'+legY+'" font-size="7" fill="#94a3b8">\u7ed9\u836f\uff1a</text>');
    lx+=26;
    activeDrugTypes.forEach(function(cfg){
      s.push('<rect x="'+lx+'" y="'+(legY-7)+'" width="16" height="8" rx="2" fill="'+cfg.color+'" fill-opacity="0.35" stroke="'+cfg.color+'" stroke-width="0.8"/>');
      s.push('<text x="'+(lx+19)+'" y="'+legY+'" font-size="7" fill="#475569">'+esc(cfg.short)+'</text>');
      lx+=19+esc(cfg.short).length*6+8;
    });
    if(activeDrugAdmins.some(function(d){return d.doseAdjusted;})){
      s.push('<rect x="'+lx+'" y="'+(legY-7)+'" width="16" height="8" rx="2" fill="#fde68a" stroke="#b45309" stroke-width="1.5"/>');
      s.push('<text x="'+(lx+19)+'" y="'+legY+'" font-size="7" fill="#78350f">\u5242\u91cf\u8c03\u6574</text>');
    }
  }
  s.push('</svg>');
  var gl=[1,2,3,4,5].filter(function(g){return gc[g]>0;}).map(function(g){
    return '<span style="display:inline-flex;align-items:center;gap:2px;margin-right:7px"><span style="width:8px;height:8px;border-radius:2px;background:'+gC[g]+';display:inline-block"></span><span style="font-size:9px;color:#64748b">G'+g+'</span></span>';
  }).join('')+'<span style="display:inline-flex;align-items:center;gap:2px;margin-right:7px"><svg width="6" height="6" style="flex-shrink:0" viewBox="0 0 6 6"><polygon points="3,0 6,3 3,6 0,3" fill="#dc2626"/></svg><span style="font-size:9px;color:#64748b"> SAE</span></span>'+
    (hasDrugs?'<span style="font-size:9px;color:#475569;margin-left:6px">\u8272\u5e26=\u7ed9\u836f\u5468\u671f \uff5c \u9ec4\u8272=\u5242\u91cf\u8c03\u6574</span>':'');
  ct.innerHTML='<div class="ct">AE \u65f6\u5e8f\u56fe</div>'+s.join('')+'<div style="margin-top:5px;display:flex;flex-wrap:wrap;align-items:center">'+gl+'</div>';
}
renderTimeline();
})();`;

  const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,sans-serif;font-size:13px;background:#f8fafc;color:#1e293b;padding:24px}
h1{font-size:1.3rem;font-weight:700;color:#1e3a5f;margin-bottom:8px}
.meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:.82rem;color:#64748b;margin-bottom:16px}
.sb{display:inline-block;padding:2px 9px;border-radius:9999px;font-weight:600;font-size:.78rem}.sw{background:#fff3cd;color:#856404}.sd{background:#fee2e2;color:#991b1b}
.card{background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:16px;margin-bottom:16px}
.ct{font-size:.78rem;font-weight:700;color:#94a3b8;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
thead{background:#1e3a5f;color:#fff}th{padding:10px 12px;text-align:left;font-size:.75rem;font-weight:600;white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:.82rem}
tr:last-child td{border-bottom:none}tbody tr:hover td{background:#f1f5f9!important}
.rw td{background:#fffbeb}.rd td,.rs td{background:#fff1f2}
.gr{display:inline-block;padding:1px 7px;border-radius:4px;font-weight:700;font-size:.78rem}.g12{background:#e2e8f0;color:#334155}.g3{background:#fed7aa;color:#9a3412}.g45{background:#fecaca;color:#7f1d1d}
.t{display:inline-block;margin-left:4px;padding:1px 5px;border-radius:3px;font-size:.7rem;font-weight:700;vertical-align:middle}
.ts{background:#dc2626;color:#fff}.ta{background:#d97706;color:#fff}td strong{font-weight:600}.dr{font-weight:600;color:#1e3a5f;font-size:.8rem}`;

  const modeText = state.blindMode ? '盲态字段' : '真实字段';
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>不良事件 — ${esc(patient.patientId)}</title>
<style>${css}</style></head>
<body>
<h1>不良事件 — ${esc(patient.patientId)}</h1>
<div class="meta"><span>共 <strong>${list.length}</strong> 条</span><span>药物显示：${modeText}</span>${badges ? " " + badges : ""}</div>
<div class="card" id="tChart"></div>
<div class="card">
<table><thead><tr>
  <th>序号</th><th>AE名称</th><th>LLT_CN</th><th>PT_CN</th><th>PT Code</th><th>SOC_CN</th>
  <th>Grade</th><th>开始日期</th>
  <th>AE转归</th><th>转归日期</th><th>纠正治疗</th><th>与药物关系及措施</th>
</tr></thead><tbody>${rows}</tbody></table>
</div>
<script type="application/json" id="aeData">${jsonData}<\/script>
<script>${clientScript}<\/script>
</body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  aePopupWindow = window.open(url, "_blank");
  window.setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\n/g, "&#10;");
}

configureEdcParser({
  createWorkerSource: createParserWorkerSource,
  finalizePatient,
});

window.MedicalEngineApi = Object.freeze({
  getPatients: () => state.patients,
  getPatient: (patientId) => state.patients.get(patientId),
  getSelectedPatient: () => state.patients.get(state.selectedPatientId),
  getSelectedPatientId: () => state.selectedPatientId,
});

window.MedicalEngineLabAeApi = getReadOnlyLabAeApi(state);
