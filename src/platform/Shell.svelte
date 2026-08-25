<script lang="ts">
  /**
   * The frame every screen sits in.
   *
   * The standalone text editor is mounted as its own route rather than being
   * folded in straight away: it is the one part of this codebase people already
   * depend on, and it keeps working untouched until its tool entry is ready.
   */
  import LegacyEditor from '../App.svelte';
  import Header from './components/Header.svelte';
  import Home from './routes/Home.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import Workspace from './routes/Workspace.svelte';
  import { prefs } from './prefs.svelte';
  import { router } from './router.svelte';
  import { session } from './session.svelte';
  import { getTool } from '../tools/registry';

  const route = $derived(router.route);
  const tool = $derived(route.name === 'tool' ? getTool(route.toolId) : null);

  // A hand-typed hash for a tool that does not exist should land somewhere
  // real, not on a blank frame.
  $effect(() => {
    if (route.name === 'tool' && !tool) router.home();
  });

  $effect(() => {
    document.documentElement.lang = prefs.locale;
  });
</script>

{#if route.name === 'legacy'}
  <div class="legacy-frame">
    <UpdateBanner />
    <div class="legacy-bar">
      <button class="ghost" onclick={() => router.home()}>‹ {prefs.t('brand')}</button>
      <span>{prefs.t('legacyEditor')}</span>
    </div>
    <div class="legacy-body">
      <LegacyEditor />
    </div>
  </div>
{:else}
  <div class="shell">
    <UpdateBanner />
    <Header
      title={tool ? prefs.pick(tool.name) : ''}
      onback={route.name === 'tool' ? () => router.home() : undefined}
    />

    <main>
      {#if route.name === 'tool' && tool}
        <!-- Keyed so the workspace re-initialises per tool. That lets it adopt
             the tool synchronously in its own script, before any options panel
             renders — an $effect here runs a paint too late, and the panel got
             a null tool on a deep link. -->
        {#key tool.id}
          <Workspace {tool} />
        {/key}
      {:else}
        <Home />
      {/if}
    </main>

    <!-- Privacy / Terms / Contact belong here, but only once there are pages
         behind them: link-shaped text that does nothing is a small lie, and the
         one claim this footer does make has to stay trustworthy. -->
    <footer>
      <span>{prefs.t('privacyFoot')}</span>
    </footer>
  </div>
{/if}

<style>
  .shell {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  main { flex: 1; }

  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3) var(--space-5);
    padding: var(--space-5) var(--space-6);
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: var(--fs-1);
    color: var(--text-muted);
  }

  .legacy-frame { height: 100%; display: flex; flex-direction: column; }
  .legacy-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--accent-line);
    font-size: var(--fs-1);
    color: var(--text-muted);
    flex: none;
  }
  .legacy-body { flex: 1; min-height: 0; }
</style>
