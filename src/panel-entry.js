// Both official entrypoints share one SDK bundle. Only the requested view
// initializes or registers event handlers.
if (document.documentElement.dataset.cnccView === 'nested') {
  require('./nesting-panel.js').mountNestingPanel();
} else {
  require('./archive-panel-source.js');
}
