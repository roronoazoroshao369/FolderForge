import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  Boxes,
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  Puzzle,
  ScrollText,
  Settings as SettingsIcon,
  Share2,
  Wrench,
} from 'lucide-react';
import { getToken } from './api';
import { ToastProvider, cx } from './ui';
import { OverviewScreen } from './screens/Overview';
import { FleetScreen } from './screens/Fleet';
import { ToolsScreen } from './screens/Tools';
import { TunnelsScreen } from './screens/Tunnels';
import { WorkspacesScreen } from './screens/Workspaces';
import { PluginsScreen } from './screens/Plugins';
import { ApprovalsScreen } from './screens/Approvals';
import { AuditScreen } from './screens/Audit';
import { SettingsScreen } from './screens/Settings';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/fleet', label: 'Fleet', icon: Boxes },
  { to: '/tools', label: 'Tools', icon: Wrench },
  { to: '/tunnels', label: 'Tunnels', icon: Share2 },
  { to: '/workspaces', label: 'Workspaces', icon: FolderGit2 },
  { to: '/plugins', label: 'Plugins', icon: Puzzle },
  { to: '/approvals', label: 'Approvals', icon: ListChecks },
  { to: '/audit', label: 'Audit', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

function Shell() {
  const location = useLocation();
  const active =
    NAV.find((n) => ('end' in n && n.end ? location.pathname === n.to : location.pathname.startsWith(n.to))) ??
    NAV[0];
  return (
    <div className="grid min-h-screen md:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="md:sticky md:top-0 md:h-screen flex md:flex-col gap-5 p-4 border-b md:border-b-0 md:border-r border-border bg-[#0d121a]/95">
        <div className="flex items-center gap-2.5 px-1">
          <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-accent-deep text-accent font-mono text-[13px] font-bold">
            FF
          </span>
          <div className="leading-tight">
            <strong className="block text-sm">FolderForge</strong>
            <span className="block text-[11px] text-muted">Mission Control</span>
          </div>
        </div>
        <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item && item.end}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] whitespace-nowrap transition-colors',
                  isActive ? 'bg-accent-deep text-accent' : 'text-muted hover:text-fg hover:bg-raised',
                )
              }
            >
              <item.icon size={15} aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="hidden md:block mt-auto px-1 font-mono text-[10px] text-muted">
          governed by policy + audit
        </div>
      </aside>
      <main className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 px-6 lg:px-8 py-4 border-b border-border bg-bg/90 backdrop-blur">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse-dot shrink-0" aria-hidden />
            <h1 className="m-0 text-[15px] font-semibold truncate">{active.label}</h1>
          </div>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cx(
                'rounded-lg border px-3 py-1.5 text-xs font-mono transition-colors',
                isActive ? 'border-[#297956] text-accent' : 'border-border text-muted hover:text-fg',
              )
            }
          >
            {getToken() ? 'token · set' : 'set token'}
          </NavLink>
        </header>
        <div key={location.pathname} className="p-6 lg:p-8 max-w-[1240px] mx-auto animate-fade-in">
          <Routes>
            <Route path="/" element={<OverviewScreen />} />
            <Route path="/fleet" element={<FleetScreen />} />
            <Route path="/tools" element={<ToolsScreen />} />
            <Route path="/tunnels" element={<TunnelsScreen />} />
            <Route path="/workspaces" element={<WorkspacesScreen />} />
            <Route path="/plugins" element={<PluginsScreen />} />
            <Route path="/approvals" element={<ApprovalsScreen />} />
            <Route path="/audit" element={<AuditScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export function App() {
  // Served under /app by the dashboard server; plain / in vite dev.
  const basename = window.location.pathname.startsWith('/app') ? '/app' : '/';
  return (
    <ToastProvider>
      <BrowserRouter basename={basename}>
        <Shell />
      </BrowserRouter>
    </ToastProvider>
  );
}
