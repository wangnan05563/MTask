import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { Tab } from '../tabs';
import { NAV_GROUPS, navGroupForTab } from './primaryNavGroups';

interface PrimaryNavProps {
  readonly activeTab: Tab;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onSelect: (tab: Tab) => void;
}

/**
 * T06289：左侧一级导航（5 项）+ 当前入口的二级页签。
 * 折叠只收起文字与二级页签，图标仍保留完整 aria-label，键盘与悬浮提示不受影响。
 */
export function PrimaryNav({ activeTab, collapsed, onToggle, onSelect }: PrimaryNavProps) {
  const activeGroup = navGroupForTab(activeTab);
  const toggleLabel = collapsed ? '展开导航' : '折叠导航';

  return (
    <aside className={`mt-primary-nav${collapsed ? ' is-collapsed' : ''}`} aria-label="主导航">
      <div className="mt-nav-brand">
        <button
          type="button"
          className="mt-nav-mark"
          onClick={() => onSelect('dashboard')}
          title="MTask 首页"
          aria-label="MTask 首页"
        >
          M
        </button>
        <span className="mt-nav-name">MTask</span>
        <button
          type="button"
          className="mt-nav-collapse"
          onClick={onToggle}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          aria-controls="mt-primary-nav-groups"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav className="mt-nav-groups" id="mt-primary-nav-groups" aria-label="一级导航">
        {NAV_GROUPS.map((group, index) => {
          const Icon = group.icon;
          const active = group.key === activeGroup.key;
          const hasChildren = group.tabs.length > 1;
          return (
            <div className={`mt-nav-group${active ? ' is-active' : ''}`} key={group.key}>
              <button
                type="button"
                className="mt-nav-item"
                onClick={() => onSelect(group.defaultTab)}
                title={`${group.label}（快捷键 ${index + 1}）`}
                aria-label={group.label}
                aria-current={activeTab === group.defaultTab ? 'page' : undefined}
                aria-keyshortcuts={String(index + 1)}
                aria-expanded={hasChildren ? active : undefined}
              >
                <Icon size={18} />
                <span className="mt-nav-label">{group.label}</span>
                {!collapsed && hasChildren && (
                  <span className="mt-nav-chevron" aria-hidden><ChevronDown size={14} /></span>
                )}
              </button>

              {active && hasChildren && !collapsed && (
                <ul className="mt-nav-sub" aria-label={`${group.label}子页面`}>
                  {group.tabs.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        className="mt-nav-subitem"
                        onClick={() => onSelect(item.key)}
                        aria-current={activeTab === item.key ? 'page' : undefined}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
