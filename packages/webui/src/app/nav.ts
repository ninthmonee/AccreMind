import { BookMarked, ClipboardCheck, History, LayoutDashboard, LibraryBig, type LucideIcon, Radar, ShieldCheck } from 'lucide-react';
import type { View } from './app-context';

/** 顶部菜单：七项，宽屏全显示，窄屏只显示图标，手机端换到第二行横向滚动。 */
export const NAV: { id: View; label: string; icon: LucideIcon; desc: string }[] = [
  { id: 'home', label: '总览', icon: LayoutDashboard, desc: '待办、趋势与经验健康度' },
  { id: 'library', label: '知识库', icon: LibraryBig, desc: '浏览、检索与总结全部经验' },
  { id: 'review', label: '候选审核', icon: ClipboardCheck, desc: '核对基线、增量与证据' },
  { id: 'docs', label: '规则文档', icon: BookMarked, desc: '业务领域、业务规则、项目规范与修改提议' },
  { id: 'governance', label: '治理', icon: ShieldCheck, desc: '复核时效、处理反证与设置' },
  { id: 'receipts', label: '回合记录', icon: History, desc: '每轮对话用到了哪些经验' },
  { id: 'radar', label: 'Git 雷达', icon: Radar, desc: '扫描提交历史，挖掘高信号经验' },
];
