function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalize(value) {
  return text(value).toLowerCase().replace(/[\s_\-/()[\]{}、，,;；:：]+/g, "");
}

function semanticKey(value) {
  return normalize(value)
    .replace(/^(血液|血清|血浆|尿液|尿)/, "")
    .replace(/(检查|检测|结果|异常|升高|降低|增高|减少|增多|水平|计数|血症|症)$/g, "")
    .replace(/^(高|低)/, "");
}

function semanticMatch(left, right) {
  const leftTerms = text(left).split(/[、，,;；|/]+/).map((value) => value.trim()).filter(Boolean);
  const rightTerms = text(right).split(/[、，,;；|/]+/).map((value) => value.trim()).filter(Boolean);
  return leftTerms.some((leftTerm) => rightTerms.some((rightTerm) => {
    const a = normalize(leftTerm);
    const b = normalize(rightTerm);
    const ak = semanticKey(leftTerm);
    const bk = semanticKey(rightTerm);
    if (!a || !b || !ak || !bk) return false;
    return a.includes(b) || b.includes(a) || ak.includes(bk) || bk.includes(ak);
  }));
}

function numeric(value) {
  const match = text(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function evaluateArithmetic(expression, values) {
  const source = expression.replace(/\b(LLN|ULN|lab value)\b/gi, (name) => {
    const key = name.toLowerCase() === "lab value" ? "value" : name.toLowerCase();
    return Number.isFinite(values[key]) ? String(values[key]) : "NaN";
  }).replace(/\s*x\s*/gi, "*");
  if (!/^[\d\s.+*/()NaN-]+$/.test(source)) return Number.NaN;
  try { return Function(`"use strict"; return (${source});`)(); } catch { return Number.NaN; }
}

function evaluateGradeCondition(condition, values) {
  const raw = text(condition).toLowerCase();
  if (!raw || raw === "-") return false;
  return raw.replace(/[()]/g, "").split(/\s+or\s+/).some((branch) =>
    branch.split(/\s+and\s+/).every((clause) => {
      if (/baseline|base_lln|base_uln/.test(clause)) return false;
      const parts = clause.split(/\s*(<=|>=|<|>)\s*/);
      if (parts.length < 3 || parts.length % 2 === 0) return false;
      for (let index = 1; index < parts.length; index += 2) {
        const left = evaluateArithmetic(parts[index - 1], values);
        const right = evaluateArithmetic(parts[index + 1], values);
        if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
        const operator = parts[index];
        if (operator === "<=" && !(left <= right)) return false;
        if (operator === ">=" && !(left >= right)) return false;
        if (operator === "<" && !(left < right)) return false;
        if (operator === ">" && !(left > right)) return false;
      }
      return true;
    })
  );
}

export function buildCtcGrd(patient, ctcRows) {
  const rows = ctcRows.filter((row) => row["LBTEST_CN"]);
  patient.labae_grd = (patient.labae_pt_chk || []).map((lab) => {
    const value = numeric(lab.result);
    const lln = numeric(lab.referenceLow || lab.standardLow || lab.referenceRange?.split(" - ")[0]);
    const uln = numeric(lab.referenceHigh || lab.standardHigh || lab.referenceRange?.split(" - ")[1]);
    const unit = normalize(lab.standardUnit || lab.unit);
    const testName = normalize(lab["HRSTD LBTEST-CN"]);
    let direction = "";
    if (Number.isFinite(value) && Number.isFinite(lln) && value < lln) direction = "DEC";
    else if (Number.isFinite(value) && Number.isFinite(uln) && value > uln) direction = "INC";
    const candidates = rows.filter((row) => normalize(row["LBTEST_CN"]) === testName && normalize(row["LBSTRESU"]) === unit);
    const directional = direction ? candidates.filter((row) => row["LBTOXDIR"] === direction) : [];
    const rule = directional[0] || null;
    const values = { value, lln, uln };
    let labAeGrd = "Grade 0";
    if (rule) {
      for (let grade = 4; grade >= 1; grade -= 1) {
        if (evaluateGradeCondition(rule[`GRADE${grade}`], values)) {
          labAeGrd = `Grade ${grade}`;
          break;
        }
      }
    }
    return {
      ...lab,
      LBTOXCN: rule?.LBTOXCN || "",
      LBTEST_CN: rule?.LBTEST_CN || "",
      LBTOXDIR: rule?.LBTOXDIR || "",
      LBSTRESU: rule?.LBSTRESU || "",
      GRADE1: rule?.GRADE1 || "",
      GRADE2: rule?.GRADE2 || "",
      GRADE3: rule?.GRADE3 || "",
      GRADE4: rule?.GRADE4 || "",
      LABAE_GRD: lab["HRSTD LBTEST-CN"] ? labAeGrd : "Grade 0",
    };
  });
}

function gradeNumber(value) {
  const match = text(value).match(/Grade\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

export function buildCtcOut(patient) {
  const output = (patient.labae_grd || []).map((row) => ({
    ...row,
    "参与者代码": patient.patientId || "",
    LABAE_OUT: "",
    LABAE_STDTC: "",
    LABAE_ENDTC: "",
    LABAE_ST_GRP: "",
    LABAE_EN_GRP: "",
  }));
  const series = new Map();

  output.forEach((row, index) => {
    const test = text(row["HRSTD LBTEST-CN"]);
    if (!test || !Number.isFinite(row.sortableDate)) return;
    // G0 没有方向，但必须作为 INC/DEC 异常序列的结束检查纳入同一检查项序列。
    const key = test;
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(index);
  });

  series.forEach((indexes) => {
    indexes.sort((a, b) => (output[a].sortableDate - output[b].sortableDate)
      || ((output[a].sourceOrder || 0) - (output[b].sourceOrder || 0)));
    let runStart = 0;
    for (let position = 0; position < indexes.length; position += 1) {
      const index = indexes[position];
      const row = output[index];
      const grade = gradeNumber(row.LABAE_GRD);
      if (grade === 0) continue;
      const currentDate = text(row.collectionDate);
      const previous = position > 0 ? output[indexes[position - 1]] : null;
      const previousGrade = gradeNumber(previous?.LABAE_GRD);
      const previousDirection = text(previous?.LBTOXDIR);
      if (!previous || previousGrade !== grade || previousDirection !== text(row.LBTOXDIR)) {
        runStart = position;
      }

      const next = position + 1 < indexes.length ? output[indexes[position + 1]] : null;
      const nextGrade = gradeNumber(next?.LABAE_GRD);
      const nextDirection = text(next?.LBTOXDIR);
      const nextIsG0 = next && nextGrade === 0;
      const nextIsSameDirection = next && nextDirection === text(row.LBTOXDIR);
      const nextIsHigher = nextIsSameDirection && nextGrade > grade;
      const nextIsLower = nextIsSameDirection && nextGrade > 0 && nextGrade < grade;
      const nextIsSame = nextIsSameDirection && nextGrade === grade;

      row.LABAE_STDTC = currentDate;
      if (!next || nextIsSame) {
        row.LABAE_OUT = "未恢复/未解决";
        row.LABAE_ST_GRP = text(output[indexes[runStart]].collectionDate);
        continue;
      }
      if (nextIsG0) {
        row.LABAE_OUT = "已恢复";
        row.LABAE_ENDTC = text(next.collectionDate);
        row.LABAE_ST_GRP = currentDate;
        row.LABAE_EN_GRP = text(next.collectionDate);
      } else if (nextIsHigher) {
        row.LABAE_OUT = "未恢复/未解决，等级加重";
        row.LABAE_ENDTC = text(next.collectionDate);
        row.LABAE_ST_GRP = text(output[indexes[runStart]].collectionDate);
        row.LABAE_EN_GRP = text(next.collectionDate);
      } else if (nextIsLower) {
        row.LABAE_OUT = "恢复中";
        row.LABAE_ENDTC = text(next.collectionDate);
        row.LABAE_ST_GRP = text(output[indexes[runStart]].collectionDate);
        row.LABAE_EN_GRP = text(next.collectionDate);
      } else {
        row.LABAE_OUT = "未恢复/未解决";
        row.LABAE_ST_GRP = text(output[indexes[runStart]].collectionDate);
      }
    }
  });
  patient.labae_out = output;
}

function parseDate(value) {
  if (!value || /(^|[-/])uk($|[-/])/i.test(text(value))) return Number.NaN;
  if (typeof value === "number" && window.XLSX?.SSF) {
    const parsed = window.XLSX.SSF.parse_date_code(value);
    if (parsed) return Date.UTC(parsed.y, parsed.m - 1, parsed.d);
  }
  const parsed = Date.parse(text(value).replace(/\./g, "-").replace(/\//g, "-"));
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function dateText(value) {
  if (!Number.isFinite(value)) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function createDummySv(patients) {
  patients.forEach((patient) => {
    const grouped = new Map();
    (patient.svRows || []).forEach((row) => {
      const visit = text(row.visit);
      const date = Number.isFinite(row.date) ? row.date : parseDate(row.date);
      if (!visit || !Number.isFinite(date)) return;
      const current = grouped.get(visit) || { visitName: visit, start: date, end: date };
      current.start = Math.min(current.start, date);
      current.end = Math.max(current.end, date);
      grouped.set(visit, current);
    });
    patient.dummy_sv = [...grouped.values()].sort((a, b) => a.start - b.start).map((row) => ({
      patientId: patient.patientId,
      visitName: row.visitName,
      SVSTDTC: dateText(row.start),
      SVENDTC: dateText(row.end),
      startSortableDate: row.start,
      endSortableDate: row.end,
    }));
  });
}

function selectDummySvVisit(visits, date) {
  if (!visits.length || !Number.isFinite(date)) return null;
  if (date < visits[0].startSortableDate) return visits[0];

  // 取最后一个 start <= 采样日期的访视：边界日期命中后一个访视，符合 T1/T2 示例。
  let selected = null;
  for (const visit of visits) {
    if (visit.startSortableDate <= date && date <= visit.endSortableDate) selected = visit;
  }
  if (selected) return selected;
  return visits.find((visit) => visit.startSortableDate > date) || visits[visits.length - 1];
}

function deriveLabVisitNames(patient) {
  patient.labAeList = (patient.labAeList || []).map((lab) => {
    return {
      ...lab,
      // Lab 数据没有“计划外”字段，原访视名称即为计划内访视名称。
      访视名称_NEW_LB: text(lab.visitLabel),
    };
  });
}

function attachMappings(patient, mappingData) {
  // 以上一步“mapping关系与检查项一致性核查”的结果为主表，保留 consistency 字段。
  const rows = mappingData?.consistency || mappingData?.mapping || [];
  const byEdcName = new Map(rows.map((row) => [normalize(row["EDC Labtest"]), row]));
  patient.labAeList = (patient.labs || []).map((lab) => ({
    ...lab,
    mapping: byEdcName.get(normalize(lab.name)) || null,
  }));
}

function buildLabaePtChk(patient, mappingData) {
  const libraryRows = mappingData?.mappingLibrary || [];
  const byHrstdCn = new Map(libraryRows.map((row) => [normalize(row["HRSTD LBTEST-CN"]), row]));
  patient.labae_pt_chk = (patient.labAeList || []).map((lab) => {
    const mapping = lab.mapping || {};
    const library = byHrstdCn.get(normalize(mapping["HRSTD LBTEST-CN"])) || null;
    return {
      ...lab,
      "HRSTD LBTEST-CN": mapping["HRSTD LBTEST-CN"] || "",
      "编码描述-CN": library?.["编码描述-CN"] || "",
      "检查PT": library?.["检查PT"] || "",
      mappingLibrary: library,
    };
  });
}

function deriveAeVisitNames(patients) {
  patients.forEach((patient) => {
    const visits = patient.dummy_sv || [];
    patient.ae_normalized = (patient.aeList || []).map((ae) => {
      const output = {
        ...ae,
        "参与者代码": patient.patientId || "",
        PT_CN: ae.ptCn || "",
        LLT_CN: ae.lltCn || "",
        SOC_CN: ae.socCn || "",
        visitName_NEW: "",
      };
      const date = Number.isFinite(ae.sortableDate) ? ae.sortableDate : parseDate(ae.startDate);
      const visit = visits.find((item) => date >= item.startSortableDate && date <= item.endSortableDate);
      if (visit) output.visitName_NEW = visit.visitName;
      return output;
    });
  });
}

function buildLabaeAeLinked(patient) {
  const labRows = patient.labae_out || [];
  const aeRows = patient.ae_normalized || [];
  const participantCode = patient.patientId || "";
  const matches = [];

  labRows.forEach((lab) => {
    const labParticipant = text(lab["参与者代码"] || participantCode);
    const labTerms = [lab["检查PT"], lab["编码描述-CN"]].filter((value) => text(value));
    aeRows.forEach((ae) => {
      const aeParticipant = text(ae["参与者代码"] || participantCode);
      const aeTerms = [ae.PT_CN, ae.ptCn, ae.LLT_CN, ae.lltCn].filter((value) => text(value));
      const isMatched = labTerms.some((labTerm) =>
        aeTerms.some((aeTerm) => semanticMatch(labTerm, aeTerm))
      );
      if (labParticipant !== aeParticipant || !isMatched) return;
      matches.push({
        "参与者代码": participantCode,
        build_ctc_out: { ...lab },
        ae_normalized: { ...ae },
      });
    });
  });
  return matches;
}

export function deriveLabAe(patients, labAeData) {
  createDummySv(patients);
  deriveAeVisitNames(patients);
  const mappingData = labAeData?.mapping ? labAeData.mapping : labAeData;
  patients.forEach((patient) => {
    attachMappings(patient, mappingData);
    deriveLabVisitNames(patient);
    buildLabaePtChk(patient, mappingData);
    buildCtcGrd(patient, labAeData?.ctc?.grades || []);
    buildCtcOut(patient);
    patient.labae_ae_linked = buildLabaeAeLinked(patient);
    patient.labae_view = patient.labae_out || [];
  });
  return patients;
}

export function getReadOnlyLabAeApi(state) {
  const clone = (value) => {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === "object") {
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])));
    }
    return value;
  };
  return Object.freeze({
    getData: () => clone(state.labAeData),
    getDummySv: (patientId) => clone(state.patients.get(patientId)?.dummy_sv || []),
    getAe: (patientId) => clone(state.patients.get(patientId)?.aeList || []),
    getAeNormalized: (patientId) => clone(state.patients.get(patientId)?.ae_normalized || []),
    getLabAeView: (patientId) => clone(state.patients.get(patientId)?.labae_view || []),
    getLabaePtChk: (patientId) => clone(state.patients.get(patientId)?.labae_pt_chk || []),
    getLabaeGrd: (patientId) => clone(state.patients.get(patientId)?.labae_grd || []),
    getLabaeOut: (patientId) => clone(state.patients.get(patientId)?.labae_out || []),
    getLabaeAeLinked: (patientId) => clone(state.patients.get(patientId)?.labae_ae_linked || []),
  });
}

export { parseDate };
