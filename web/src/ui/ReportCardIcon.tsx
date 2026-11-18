import aiImport from '../assets/report-icons/ai-import.png';
import offline from '../assets/report-icons/offline.png';
import aiLive from '../assets/report-icons/ai-live.png';
import prdGen from '../assets/report-icons/prd-gen.png';
import prdImport from '../assets/report-icons/prd-import.png';
import tcGen from '../assets/report-icons/tc-gen.png';
import kickoffPpt from '../assets/report-icons/kickoff-ppt.png';
import summaryPpt from '../assets/report-icons/summary-ppt.png';
import reviewLecture from '../assets/report-icons/review-lecture.png';
import gitExtract from '../assets/report-icons/git-extract.png';
import sonarScan from '../assets/report-icons/sonar-scan.png';

/** T06016：AI 工作台 11 张能力卡片图标（512 缩放版接入）。 */
const ICON_SRC = {
  'ai-import': aiImport,
  offline,
  'ai-live': aiLive,
  'prd-gen': prdGen,
  'prd-import': prdImport,
  'tc-gen': tcGen,
  'kickoff-ppt': kickoffPpt,
  'summary-ppt': summaryPpt,
  'review-lecture': reviewLecture,
  'git-extract': gitExtract,
  'sonar-scan': sonarScan,
} as const;

export type ReportCardIconKey = keyof typeof ICON_SRC;

export function ReportCardIcon({ name, size = 30 }: { readonly name: ReportCardIconKey; readonly size?: number }) {
  return (
    <img
      src={ICON_SRC[name]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      style={{ display: 'block', width: size, height: size, objectFit: 'contain', userSelect: 'none' }}
    />
  );
}
