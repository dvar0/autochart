import { useEffect, useRef } from "react";
import useGenerateProject from "./useGenerateProject.js";
import ProjectBar from "./ProjectBar.jsx";
import PreviewStage from "./PreviewStage.jsx";
import TakesDeck from "./TakesDeck.jsx";
import Console from "./Console.jsx";
import LibraryFolderPrompt from "../../components/LibraryFolderPrompt.jsx";
import MoreSettings from "./MoreSettings.jsx";
import EditTimeline from "./edit/EditTimeline.jsx";
import EditInspector from "./edit/EditInspector.jsx";
import useEditWorkspace from "./edit/useEditWorkspace.js";

import UnsupportedGenerationState from "./UnsupportedGenerationState.jsx";
import { targetLabel } from "../../data/supportedTargets.js";
// Generate screen v3 — "Studio Deck". DAW mental model: monitor (stage) in the
// middle, channel strip (console) on the right, takes at the bottom. This file
// owns only the grid skeleton and hands the project state hook to each region.
//
// The rail's tabs pick the job. Generate shows the console and the takes
// deck; Inpaint and Edit swap them for the editor panel and the song map +
// piano roll. The stage stays put through every switch: one highway, one
// playhead.
export default function GeneratePage({ importedSong, initialFile = null, onSongTitle, onSaved, onGeneratedSong, onProjectIdentified, onSetup, onOpenSettings, active = true, workspaceKey, onBusyChange }) {
  const project = useGenerateProject({ importedSong, onSaved, onGeneratedSong, onProjectIdentified, visible: active });
  const highwayRef = useRef(null);
  const ws = useEditWorkspace(project, highwayRef, active);

  // A project begun from the web Start page arrives with its song file. (Under
  // StrictMode this runs twice; the second read supersedes the first.)
  useEffect(() => {
    if (initialFile) project.handleMediaFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The web rail names the open song.
  const songTitle = project.hasMedia ? project.details?.title || "Untitled song" : "";
  useEffect(() => {
    onSongTitle?.(workspaceKey, songTitle);
  }, [workspaceKey, songTitle, onSongTitle]);

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

  const editing = project.workTab !== "generate";
  return (
    <div className="ac-body">
      <div className="main" style={{ padding: 0 }}>
        <div className={"gen-screen" + (editing ? " is-editing" : "")} data-tab={project.workTab}>
          <ProjectBar project={project} />
          <PreviewStage project={project} ws={ws} highwayRef={highwayRef} />
          {editing ? (
            <>
              <EditTimeline project={project} ws={ws} />
              <EditInspector project={project} ws={ws} />
            </>
          ) : (
            <>
              {project.hasMedia && <TakesDeck project={project} />}
              <Console project={project} />
              {project.hasMedia && project.advancedSettingsOpen && <MoreSettings project={project} />}
            </>
          )}
        </div>
        <LibraryFolderPrompt gate={project.libraryFolderGate} onOpenSettings={onOpenSettings} />
      </div>
    </div>
  );
}
