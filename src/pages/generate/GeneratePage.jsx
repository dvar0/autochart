import { useEffect } from "react";
import useGenerateProject from "./useGenerateProject.js";
import ProjectBar from "./ProjectBar.jsx";
import PreviewStage from "./PreviewStage.jsx";
import TakesDeck from "./TakesDeck.jsx";
import Console from "./Console.jsx";
import LibraryFolderPrompt from "../../components/LibraryFolderPrompt.jsx";

import UnsupportedGenerationState from "./UnsupportedGenerationState.jsx";
import { targetLabel } from "../../data/supportedTargets.js";
// Generate screen v3 — "Studio Deck". DAW mental model: monitor (stage) in the
// middle, channel strip (console) on the right, takes at the bottom. This file
// owns only the grid skeleton and hands the project state hook to each region.
export default function GeneratePage({ importedSong, onSaved, onGeneratedSong, onProjectIdentified, onSetup, onOpenSettings, active = true, workspaceKey, onBusyChange }) {
  const project = useGenerateProject({ importedSong, onSaved, onGeneratedSong, onProjectIdentified, visible: active });

  useEffect(() => {
    onBusyChange?.(workspaceKey, project.busy);
  }, [workspaceKey, project.busy, onBusyChange, active]);

  // Keep the project and its job subscription alive while away. Unmount the
  // playback surfaces so hidden projects don't keep playing audio or rendering.
  if (!active) return null;

  if (project.unsupportedTarget) {
    return (
      <UnsupportedGenerationState
        targetLabel={targetLabel(project.targetPlatform, project.targetArch)}
        message={project.setupMessage}
      />
    );
  }

  if (project.setupBlocking) {
    return (
      <div className="ac-body setup-cta-page">
        <main className="settings-main">
          <header className="page-head">
            <h1 className="page-title">Chart generation needs setup</h1>
            <p className="page-sub">
              Download or locate the chart generation package before making charts.
            </p>
          </header>
          <section className="setup-cta-panel">
            <div>
              <h2>Chart generation package is missing</h2>
              <p>{project.setupMessage || "Open setup to scan the chart generation files and choose runtime settings."}</p>
            </div>
            <button className="btn-primary" onClick={onSetup}>
              Set Up Autochart
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="ac-body">
      <div className="main" style={{ padding: 0 }}>
        <div className="gen-screen">
          <ProjectBar project={project} />
          <PreviewStage project={project} />
          {project.hasMedia && <TakesDeck project={project} />}
          <Console project={project} />
        </div>
        <LibraryFolderPrompt gate={project.libraryFolderGate} onOpenSettings={onOpenSettings} />
      </div>
    </div>
  );
}
