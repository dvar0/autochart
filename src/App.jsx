import { useCallback, useEffect, useRef, useState } from "react";
import { Rail } from "./components/index.jsx";
import { getAppSettings, updateAppSettings } from "./services/appSettings.js";
import { browserHasLocalSongRecords, getSongRecord, recordToImported } from "./services/songLibrary.js";
import { subscribeGenerationEvents } from "./services/generation.js";
import Generate from "./pages/generate/GeneratePage.jsx";
import Library from "./pages/Library.jsx";
import SetupWizard from "./pages/SetupWizard.jsx";
import Settings from "./pages/Settings.jsx";
import useResolvedTheme from "./hooks/useResolvedTheme.js";

export default function App() {
  const [themePreference, setThemePreference] = useState("system");
  const theme = useResolvedTheme(themePreference);
  const [page, setPage] = useState("library");
  // Stable workspace keys keep in-flight jobs attached to their project even
  // when a new project's saved song id arrives, or another song is opened.
  const [workspace, setWorkspace] = useState({
    projects: [{ key: "initial", songId: null, importedSong: null }],
    activeProject: "initial",
  });
  const { projects, activeProject } = workspace;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  // Library filter lives here so the nav rail can show it as a real
  // sidebar section with counts, the way desktop library apps do.
  const [libFilter, setLibFilter] = useState("all");
  const [libCounts, setLibCounts] = useState({ all: 0, favorites: 0 });
  const [railCollapsed, setRailCollapsed] = useState(false);
  const mainRef = useRef(null);

  useEffect(() => {
    let active = true;
    getAppSettings()
      .then(async (settings) => {
        if (!active || !settings) return;
        if (["system", "light", "dark"].includes(settings.theme)) setThemePreference(settings.theme);
        if (settings.railCollapsed) setRailCollapsed(true);
        if (!settings.setupComplete) {
          const hasLocalLibrary = await browserHasLocalSongRecords();
          if (!active) return;
          if (!hasLocalLibrary) setPage("setup");
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [page]);

  useEffect(() => subscribeGenerationEvents(async (event) => {
    if (event?.type !== "project_saved") return;
    setLibraryRefresh((n) => n + 1);
    const project = workspaceRef.current.projects.find(item => item.songId === event.projectId);
    // A mounted run consumes its own result. After a renderer reload, recover
    // the saved take into an idle workspace that has no completion promise.
    if (!project || project.busy) return;
    try {
      const record = await getSongRecord(event.projectId);
      if (!record) return;
      const payload = await recordToImported(record, { audioBuffer: project.importedSong?.audioBuffer });
      setWorkspace(current => ({ ...current, projects: current.projects.map(item =>
        item.key === project.key && item.songId === event.projectId && !item.busy
          ? { ...item, importedSong: payload } : item
      ) }));
    } catch (error) {
      console.warn("[generation] Could not refresh saved project:", error);
    }
  }), []);

  // Persist theme so it survives relaunches; ignore failures (browser preview).
  const handleSetTheme = (next) => {
    setThemePreference(next);
    updateAppSettings({ theme: next }).catch(() => {});
  };

  // Persist the rail's collapsed state so the desktop layout stays put.
  const handleToggleRail = () => {
    setRailCollapsed((prev) => {
      const next = !prev;
      updateAppSettings({ railCollapsed: next }).catch(() => {});
      return next;
    });
  };

  const handleImport = (data) => {
    const key = crypto.randomUUID();
    // Library loading is asynchronous: resolve against the current workspace,
    // not the project list captured before its media finished loading.
    setWorkspace((current) => {
      const existing = current.projects.find((project) => project.songId === data.id);
      return {
        activeProject: existing?.key || key,
        projects: existing
          ? current.projects
          : [...current.projects, { key, songId: data.id, importedSong: data }],
      };
    });
    setPage("generate");
  };

  const handleCreateSong = () => {
    const key = crypto.randomUUID();
    setWorkspace((current) => ({ projects: [...current.projects, { key, songId: null, importedSong: null }], activeProject: key }));
    setPage("generate");
  };

  const handleProjectIdentified = (key, songId) => {
    setWorkspace((current) => ({ ...current, projects: current.projects.map((project) =>
      project.key === key ? { ...project, songId } : project
    ) }));
  };

  const handleGeneratedSong = (key, data) => {
    setWorkspace((current) => ({ ...current, projects: current.projects.map((project) =>
      project.key === key ? { ...project, songId: data.id, importedSong: data } : project
    ) }));
  };

  const handleProjectBusyChange = useCallback((key, busy) => {
    setWorkspace((current) => {
      const next = current.projects.map((project) =>
        project.key === key && Boolean(project.busy) !== busy ? { ...project, busy } : project
      ).filter((project) => project.key === current.activeProject || project.busy);
      // Only the current workspace and background work need to hold audio and
      // chart data in memory. Completed background projects reopen from disk.
      return next.length === current.projects.length && next.every((project, i) => project === current.projects[i])
        ? current
        : { ...current, projects: next };
    });
  }, []);

  const handleLibrarySaved = () => {
    setLibraryRefresh((n) => n + 1);
  };

  const handleSetupDone = () => {
    setPage("generate");
  };

  return (
    <div className="ac-stage">
      <div
        className="ac-app"
        data-theme={theme}
        style={{ colorScheme: theme }}
        data-screen-label={"Autochart - " + page}
      >
        {page !== "setup" && <Rail
          theme={themePreference}
          setTheme={handleSetTheme}
          page={page}
          onNav={setPage}
          libFilter={libFilter}
          onLibFilter={(id) => {
            setLibFilter(id);
            setPage("library");
          }}
          libCounts={libCounts}
          collapsed={railCollapsed}
          onToggleCollapse={handleToggleRail}
        />}
        <div className="ac-main" ref={mainRef} tabIndex="-1" aria-label={`${page} page`}>
          {page === "library" && (
            <Library
              setPage={setPage}
              onImport={handleImport}
              onCreate={handleCreateSong}
              refreshToken={libraryRefresh}
              theme={theme}
              filter={libFilter}
              onCounts={setLibCounts}
            />
          )}
          {projects.map((project) => (
            <Generate
              key={project.key}
              workspaceKey={project.key}
              onBusyChange={handleProjectBusyChange}
              active={page === "generate" && activeProject === project.key}
              importedSong={project.importedSong}
              onSaved={handleLibrarySaved}
              onGeneratedSong={(data) => handleGeneratedSong(project.key, data)}
              onProjectIdentified={(songId) => handleProjectIdentified(project.key, songId)}
              onSetup={() => setPage("setup")}
              onOpenSettings={() => setPage("settings")}
            />
          ))}
          {page === "settings" && <Settings setPage={setPage} />}
          {page === "setup" && <SetupWizard onDone={handleSetupDone} />}
        </div>
      </div>
    </div>
  );
}
