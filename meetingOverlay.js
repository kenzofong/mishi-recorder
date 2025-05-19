window.addEventListener('DOMContentLoaded', () => {
  console.log('[meetingOverlay.js] DOMContentLoaded - overlay window loaded');
  const ipcRenderer = window.electron.ipcRenderer;

  // Elements
  const titleBar = document.getElementById('titleBar');
  const meetingTitle = document.getElementById('meetingTitle');
  const companyLabel = document.getElementById('companyLabel');
  const templateLabel = document.getElementById('templateLabel');
  const closeBtn = document.getElementById('closeBtn');
  const meetingSetup = document.getElementById('meetingSetup');
  const companySelect = document.getElementById('companySelect');
  const templateSelect = document.getElementById('templateSelect');
  const startMeetingBtn = document.getElementById('startMeetingBtn');
  const meetingContent = document.getElementById('meetingContent');
  const quillEditorDiv = document.getElementById('quillEditor');
  const formatBar = document.getElementById('formatBar');
  const formatButtons = document.querySelectorAll('.format-btn');
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  // Recap tab elements
  const companyRecapContainer = document.querySelector('.company-recap-container');
  const recapEmptyState = document.getElementById('recapEmptyState');
  const companyNameElement = document.getElementById('companyName');
  const companySummaryElement = document.getElementById('companySummary');
  const previousMeetingsElement = document.getElementById('previousMeetings');

  // Outline tab elements
  const outlineTabContent = document.getElementById('outlineTab');

  // --- Custom Title Bar Elements ---
  const customTitleBar = document.querySelector('.custom-titlebar');
  const customMeetingTitle = document.getElementById('customMeetingTitle');
  const customCompanyLabel = document.getElementById('customCompanyLabel');
  const customTemplateLabel = document.getElementById('customTemplateLabel');
  const newMeetingBtn = document.getElementById('newMeetingBtn');
  const windowCloseBtn = document.getElementById('windowCloseBtn');
  const windowMinBtn = document.getElementById('windowMinBtn');
  const windowMaxBtn = document.getElementById('windowMaxBtn');

  let templatesMap = {};
  let quill = null;
  let selectedCompanyId = null;
  let companyData = null;
  
  // Helper to get the current meeting ID (assume it's stored in a variable or can be derived)
  let currentMeetingId = null;
  function getCurrentMeetingId() {
    // Try to get from a global or from the latest created meeting, fallback to null
    // This should be set when a meeting is created or loaded
    return currentMeetingId;
  }

  // Simple HTML sanitizer function
  function sanitizeHTML(html) {
    if (!html) return '';
    
    // Create a new div element to use the browser's sanitization
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    
    // Remove any script tags and their content
    const scripts = tempDiv.getElementsByTagName('script');
    while (scripts[0]) {
      scripts[0].parentNode.removeChild(scripts[0]);
    }
    
    // Allow list of safe attributes for specific tags
    const safeAttributes = {
      'a': ['href', 'title', 'target'],
      'img': ['src', 'alt', 'title', 'width', 'height'],
      'all': ['id', 'class', 'style'] // Attributes allowed on all elements
    };
    
    // Process all elements to keep only safe attributes
    const allElements = tempDiv.getElementsByTagName('*');
    for (let i = 0; i < allElements.length; i++) {
      const element = allElements[i];
      const tag = element.tagName.toLowerCase();
      const attributes = element.attributes;
      
      // Get allowed attributes for this tag
      const allowedForTag = safeAttributes[tag] || [];
      const allowedForAll = safeAttributes['all'];
      
      // Remove any attributes that aren't in our safe list
      for (let j = attributes.length - 1; j >= 0; j--) {
        const attrName = attributes[j].name;
        
        // Check if attribute is allowed
        const isAllowed = allowedForTag.includes(attrName) || 
                         allowedForAll.includes(attrName);
                         
        // Always remove on* event handlers and javascript: URLs
        const isDangerous = attrName.startsWith('on') || 
                          (attrName === 'href' && attributes[j].value.trim().toLowerCase().startsWith('javascript:'));
        
        if (!isAllowed || isDangerous) {
          element.removeAttribute(attrName);
        }
      }
      
      // Make external links open in a new tab
      if (tag === 'a' && element.hasAttribute('href')) {
        // Get href value
        const href = element.getAttribute('href');
        
        // If it's an external link, add target="_blank" and rel="noopener noreferrer"
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
        }
      }
    }
    
    return tempDiv.innerHTML;
  }

  // Fetch companies and templates
  ipcRenderer.invoke('get-companies').then(res => {
    if (res.success) {
      companySelect.innerHTML = res.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      
      // Add change event listener to company select
      companySelect.addEventListener('change', handleCompanyChange);
      
      // If companies exist, trigger the change event to load the first company
      if (res.companies.length > 0) {
        console.log('[DEBUG] Companies loaded, triggering change for first company');
        selectedCompanyId = res.companies[0].id;
        companySelect.value = selectedCompanyId;
        companySelect.dispatchEvent(new Event('change'));
      }
    } else {
      companySelect.innerHTML = '<option value="">No companies</option>';
      console.warn('[meetingOverlay.js] Failed to load companies:', res.error);
    }
  }).catch(err => {
    console.error('[meetingOverlay.js] Error fetching companies:', err);
    companySelect.innerHTML = '<option value="">Error loading companies</option>';
  });

  // Handle company selection change
  async function handleCompanyChange() {
    selectedCompanyId = companySelect.value;
    console.log('[DEBUG] Company selection changed to:', selectedCompanyId);
    
    if (!selectedCompanyId) {
      // No company selected, show empty state
      console.log('[DEBUG] No company selected, showing empty state');
      companyRecapContainer.style.display = 'none';
      recapEmptyState.style.display = 'flex';
      return;
    }
    
    try {
      console.log('[DEBUG] Fetching company info for:', selectedCompanyId);
      const res = await ipcRenderer.invoke('get-company-info', selectedCompanyId);
      console.log('[DEBUG] Company info response:', res);
      
      if (res.success && res.company) {
        companyData = res.company;
        console.log('[DEBUG] Company data received:', companyData);
        
        // Update company information in the recap tab
        companyNameElement.textContent = companyData.name || 'Unknown Company';
        
        // Use innerHTML instead of textContent to properly render HTML content
        companySummaryElement.innerHTML = sanitizeHTML(companyData.summary) || 
          (sanitizeHTML(companyData.description) || 'No company summary available.');
        
        console.log('[DEBUG] Set company name to:', companyData.name);
        console.log('[DEBUG] Set company summary HTML:', companySummaryElement.innerHTML);
        
        // Fetch previous meetings for this company
        fetchPreviousMeetings(selectedCompanyId);
        
        // Show company recap, hide empty state
        console.log('[DEBUG] Making recap container visible');
        companyRecapContainer.style.display = 'block';
        recapEmptyState.style.display = 'none';
        
        // Force a reflow to ensure display changes take effect
        void companyRecapContainer.offsetHeight;
        console.log('[DEBUG] Recap container display style:', companyRecapContainer.style.display);
        console.log('[DEBUG] Recap empty state display style:', recapEmptyState.style.display);
      } else {
        console.warn('[meetingOverlay.js] Failed to load company info:', res.error);
        companyRecapContainer.style.display = 'none';
        recapEmptyState.style.display = 'flex';
      }
    } catch (err) {
      console.error('[meetingOverlay.js] Error fetching company info:', err);
      companyRecapContainer.style.display = 'none';
      recapEmptyState.style.display = 'flex';
    }
  }
  
  // Handle clicks on links inside the company summary
  companySummaryElement.addEventListener('click', async (event) => {
    // Check if the clicked element is a link
    if (event.target.tagName === 'A' && event.target.href) {
      event.preventDefault();
      
      try {
        // Try to open the link in the default browser
        console.log('[meetingOverlay.js] Opening link in browser:', event.target.href);
        await ipcRenderer.invoke('open-external-link', event.target.href);
      } catch (err) {
        console.error('[meetingOverlay.js] Error opening link:', err);
        alert('Could not open the link. Please try again.');
      }
    }
  });

  // Fetch previous meetings for a company
  async function fetchPreviousMeetings(companyId) {
    try {
      const res = await ipcRenderer.invoke('get-previous-meetings', companyId);
      
      if (res.success && res.meetings && res.meetings.length > 0) {
        previousMeetingsElement.innerHTML = res.meetings.map(meeting => {
          // Get sanitized TLDR content if available
          const tldrContent = meeting.tldr ? sanitizeHTML(meeting.tldr) : '';
          
          // Format date with more detail
          const meetingDate = new Date(meeting.created_at);
          const formattedDate = meetingDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          });
          
          return `
            <div class="meeting-item" data-meeting-id="${meeting.id}" role="button" tabindex="0">
              <div class="meeting-item-header">
                <div class="meeting-item-title">${meeting.title || 'Untitled Meeting'}</div>
                <div class="meeting-item-date">${formattedDate}</div>
              </div>
              ${tldrContent ? `<div class="meeting-item-tldr">${tldrContent}</div>` : ''}
              <div class="meeting-item-view">Click to open in web app</div>
            </div>
          `;
        }).join('');
        
        // Add click event listeners to meeting items
        document.querySelectorAll('.meeting-item').forEach(item => {
          item.addEventListener('click', async (event) => {
            const meetingId = item.getAttribute('data-meeting-id');
            if (meetingId) {
              console.log('[meetingOverlay.js] Opening meeting in web app:', meetingId);
              
              // Show loading state
              const originalContent = item.innerHTML;
              item.classList.add('loading');
              item.innerHTML = '<div class="loading-indicator">Opening meeting...</div>';
              
              try {
                const result = await ipcRenderer.invoke('open-in-web-app', { 
                  type: 'meeting', 
                  id: meetingId 
                });
                
                if (!result.success) {
                  console.error('[meetingOverlay.js] Failed to open meeting:', result.error);
                  alert(`Failed to open meeting: ${result.error}`);
                }
              } catch (err) {
                console.error('[meetingOverlay.js] Error opening meeting:', err);
                alert('Error opening meeting. Please try again.');
              } finally {
                // Reset content
                item.classList.remove('loading');
                item.innerHTML = originalContent;
              }
            }
          });
          
          // Add keyboard event listener for accessibility
          item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              item.click();
            }
          });
        });
      } else {
        previousMeetingsElement.innerHTML = `<p class="no-meetings">No previous meetings found.</p>`;
      }
    } catch (err) {
      console.error('[meetingOverlay.js] Error fetching previous meetings:', err);
      previousMeetingsElement.innerHTML = `<p class="no-meetings">Failed to load previous meetings.</p>`;
    }
  }

  ipcRenderer.invoke('get-meeting-templates').then(res => {
    if (res.success) {
      templatesMap = {};
      templateSelect.innerHTML = res.templates.map(t => {
        templatesMap[t.id] = t;
        return `<option value="${t.id}">${t.name}</option>`;
      }).join('');
      console.log('[meetingOverlay.js] Loaded templates:', Object.keys(templatesMap).length);
    } else {
      templateSelect.innerHTML = '<option value="">No templates</option>';
      console.warn('[meetingOverlay.js] Failed to load templates:', res.error);
    }
  }).catch(err => {
    console.error('[meetingOverlay.js] Error fetching templates:', err);
    templateSelect.innerHTML = '<option value="">Error loading templates</option>';
  });

  // Render agenda and open questions in the outline tab
  async function renderOutlineTab() {
    // Always ensure the container exists
    let outlineSectionContainer = outlineTabContent.querySelector('.outline-section-container');
    if (!outlineSectionContainer) {
      outlineTabContent.innerHTML = '<div class="outline-section-container"></div>';
      outlineSectionContainer = outlineTabContent.querySelector('.outline-section-container');
    }

    const meetingId = getCurrentMeetingId();
    console.log('[DEBUG] renderOutlineTab: meetingId =', meetingId);

    if (!meetingId) {
      outlineSectionContainer.innerHTML = `<div class="empty-tab-content"><h3>Agenda</h3><p>No meeting selected.</p></div>`;
      return;
    }
    outlineSectionContainer.innerHTML = `<div class="empty-tab-content"><p>Loading agenda...</p></div>`;
    try {
      const res = await ipcRenderer.invoke('get-meeting-prep', meetingId);
      console.log('[DEBUG] get-meeting-prep result:', res);
      if (!res.success || !res.prep) {
        outlineSectionContainer.innerHTML = `<div class="empty-tab-content"><h3>Agenda</h3><p>No agenda or open questions found for this meeting.</p></div>`;
        return;
      }
      const { agenda, open_questions } = res.prep;
      let html = '';
      if (agenda && agenda.length > 0) {
        html += `<div class="outline-section"><h3 class="section-title">Agenda</h3><ul class="outline-list">`;
        agenda.forEach((item, idx) => {
          html += `<li class="checklist-item">
            <span class="checklist-label">${sanitizeHTML(item)}</span>
            <button class="checklist-btn checklist-btn-check" title="Mark as done" tabindex="0" data-type="agenda" data-idx="${idx}">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="10" fill="#fff" stroke="#D1D5DB" stroke-width="2"/><path d="M6 11.5L10 15L16 8.5" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="checklist-btn checklist-btn-x" title="Mark as not applicable" tabindex="0" data-type="agenda" data-idx="${idx}">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="10" fill="#fff" stroke="#D1D5DB" stroke-width="2"/><path d="M8 8L14 14M14 8L8 14" stroke="#EF4444" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </li>`;
        });
        html += `</ul></div>`;
      }
      if (open_questions && open_questions.length > 0) {
        html += `<div class="outline-section"><h3 class="section-title">Open Questions</h3><ul class="outline-list">`;
        open_questions.forEach((q, idx) => {
          html += `<li class="checklist-item">
            <span class="checklist-label">${sanitizeHTML(q)}</span>
            <button class="checklist-btn checklist-btn-check" title="Mark as done" tabindex="0" data-type="question" data-idx="${idx}">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="10" fill="#fff" stroke="#D1D5DB" stroke-width="2"/><path d="M6 11.5L10 15L16 8.5" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button class="checklist-btn checklist-btn-x" title="Mark as not applicable" tabindex="0" data-type="question" data-idx="${idx}">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="10" fill="#fff" stroke="#D1D5DB" stroke-width="2"/><path d="M8 8L14 14M14 8L8 14" stroke="#EF4444" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </li>`;
        });
        html += `</ul></div>`;
      }
      if (!html) {
        html = `<div class="empty-tab-content"><h3>Agenda</h3><p>No agenda or open questions found for this meeting.</p></div>`;
      }
      outlineSectionContainer.innerHTML = html;
    } catch (err) {
      outlineSectionContainer.innerHTML = `<div class="empty-tab-content"><h3>Agenda</h3><p>Failed to load agenda: ${err.message}</p></div>`;
    }
  }

  // Tab functionality
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      console.log('[DEBUG] Tab clicked:', tab.getAttribute('data-tab'));
      
      // Remove active class from all tabs and tab contents
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      // Add active class to current tab and its content
      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      const tabContent = document.getElementById(`${tabName}Tab`);
      tabContent.classList.add('active');
      
      // If clicking the recap tab, ensure company info is displayed if available
      if (tabName === 'recap' && selectedCompanyId) {
        console.log('[DEBUG] Recap tab selected with company ID:', selectedCompanyId);
        if (companyData) {
          console.log('[DEBUG] Company data exists, ensuring recap container is visible');
          companyRecapContainer.style.display = 'block';
          recapEmptyState.style.display = 'none';
        }
      }
      
      // If moving to "During" tab, focus the editor
      if (tabName === 'during' && quill) {
        setTimeout(() => quill.focus(), 100);
      }

      // If clicking the outline tab, render agenda and open questions
      if (tab.getAttribute('data-tab') === 'outline') {
        renderOutlineTab();
      }

      if (typeof updateRecordBarVisibility === 'function') updateRecordBarVisibility();
    });
  });

  // Track the current meeting ID when a meeting is created
  if (startMeetingBtn) {
    startMeetingBtn.addEventListener('click', async () => {
      const companyId = companySelect.value;
      const templateId = templateSelect.value;
      
      if (!companyId || !templateId) {
        console.warn('[meetingOverlay.js] Missing company or template selection');
        return;
      }
      
      // Set title bar
      const companyName = companySelect.options[companySelect.selectedIndex]?.textContent || '[company]';
      const templateName = templateSelect.options[templateSelect.selectedIndex]?.textContent || '[template]';
      if (typeof companyLabel !== 'undefined' && companyLabel) companyLabel.textContent = companyName;
      if (typeof templateLabel !== 'undefined' && templateLabel) templateLabel.textContent = templateName;
      
      // Get template content
      const templateContent = templatesMap[templateId]?.content || '';
      console.log('[meetingOverlay.js] Selected template:', {
        id: templateId,
        name: templateName,
        hasContent: !!templateContent,
        contentLength: templateContent.length
      });
      
      let meetingId = null;
      try {
        // Make the meeting title unique by appending date, time (with seconds), and a random code
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
        const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); // HH:MM:SS
        const randomCode = Math.floor(1000 + Math.random() * 9000); // 4-digit random
        const uniqueTitle = `${companyName} Meeting - ${dateStr} ${timeStr} #${randomCode}`;
        const res = await ipcRenderer.invoke('create-meeting', {
          title: uniqueTitle,
          companyId
        });
        if (res.success && res.meeting && res.meeting.id) {
          meetingId = res.meeting.id;
          currentMeetingId = meetingId;
          console.log('[meetingOverlay.js] Created meeting with ID:', meetingId);
        } else {
          alert('Failed to create meeting: ' + (res.error || 'Unknown error'));
          return;
        }
      } catch (err) {
        alert('Error creating meeting: ' + err.message);
        return;
      }

      // Show the meeting panel immediately (optimistic UI)
      meetingSetup.style.display = 'none';
      meetingContent.style.display = 'block';

      // Show loading in outline section
      const outlineSectionContainer = outlineTabContent.querySelector('.outline-section-container');
      if (outlineSectionContainer) {
        outlineSectionContainer.innerHTML = `<div class="empty-tab-content"><p>Generating agenda and open questions...</p></div>`;
      }

      // Make sure the recap tab has the latest company information
      console.log('[DEBUG] Ensuring recap tab has latest company information');
      handleCompanyChange();

      // Switch to the recap tab first to ensure it's populated
      const recapTabBtn = document.querySelector('[data-tab="recap"]');
      if (recapTabBtn) recapTabBtn.click();
      // Then switch to the edit tab
      setTimeout(() => {
        const editTabBtn = document.querySelector('[data-tab="edit"]');
        if (editTabBtn) editTabBtn.click();
      }, 300);

      // Initialize Quill editor with bubble theme and template content
      setTimeout(() => {
        try {
          // Destroy existing quill instance if it exists
          if (quill) {
            // No direct destroy method, remove content and handlers
            quill.setText('');
            quill = null;
          }
          // Create a fresh Quill instance with bubble theme
          quill = new window.Quill('#quillEditor', {
            theme: 'bubble', // Use bubble theme instead of snow
            placeholder: 'Meeting notes...',
            formats: ['bold', 'italic', 'header', 'list', 'link'],
            modules: {
              toolbar: false // Disable default toolbar
            }
          });
          // Handle selection change to show/hide and position format bar
          quill.on('selection-change', function(range, oldRange, source) {
            if (range && range.length > 0) {
              // Text is selected, position and show format bar
              const bounds = quill.getBounds(range.index, range.length);
              showFormatBar(bounds);
              updateFormatButtons(quill, range);
            } else {
              // No selection, hide format bar
              hideFormatBar();
            }
          });
          // Wait for Quill to be fully initialized before setting content
          setTimeout(() => {
            try {
              // Set content safely using Quill's proper methods
              if (templateContent) {
                // Use pasteHTML for HTML content
                if (templateContent.trim().startsWith('<')) {
                  // First clear any existing content
                  quill.setText('');
                  // Insert HTML content
                  quill.clipboard.dangerouslyPasteHTML(0, templateContent);
                } else {
                  quill.setText(templateContent);
                }
              }
              console.log('[meetingOverlay.js] Successfully set template content in Quill editor');
            } catch (err) {
              console.error('[meetingOverlay.js] Error setting template content:', err);
            }
          }, 100);
        } catch (err) {
          console.error('[meetingOverlay.js] Error initializing Quill:', err);
        }
      }, 400);

      // Start generating meeting prep, but don't block UI
      ipcRenderer.invoke('generate-meeting-prep', meetingId).then(prepRes => {
        // When ready, re-render the outline tab
        renderOutlineTab();
      }).catch(err => {
        const outlineSectionContainer = outlineTabContent.querySelector('.outline-section-container');
        if (outlineSectionContainer) {
          outlineSectionContainer.innerHTML = `<div class=\"empty-tab-content\"><p>Failed to generate agenda: ${err.message}</p></div>`;
        }
      });

      if (typeof updateRecordBarVisibility === 'function') updateRecordBarVisibility();

      // After successful creation, get selected company/template names
      const selectedCompanyName = companySelect.options[companySelect.selectedIndex]?.textContent || '';
      const selectedTemplateName = templateSelect.options[templateSelect.selectedIndex]?.textContent || '';
      showMeetingContent(selectedCompanyName, selectedTemplateName);
    });
  }

  // Floating format bar functions
  function showFormatBar(bounds) {
    // Position the format bar above the selection
    formatBar.style.left = `${bounds.left + window.scrollX}px`;
    formatBar.style.top = `${bounds.top + window.scrollY - formatBar.offsetHeight - 10}px`;
    
    // Make sure it's visible within the window
    const barRect = formatBar.getBoundingClientRect();
    if (barRect.left < 10) {
      formatBar.style.left = '10px';
    } else if (barRect.right > window.innerWidth - 10) {
      formatBar.style.left = `${window.innerWidth - barRect.width - 10}px`;
    }
    
    // Show the format bar
    formatBar.classList.add('visible');
  }
  
  function hideFormatBar() {
    formatBar.classList.remove('visible');
  }
  
  function updateFormatButtons(quill, range) {
    const formats = quill.getFormat(range);
    
    // Update button active states based on current formats
    formatButtons.forEach(button => {
      const format = button.dataset.format;
      const value = button.dataset.value;
      
      if (format === 'header' && value) {
        button.classList.toggle('active', formats.header == value);
      } else if (format === 'list' && value) {
        button.classList.toggle('active', formats.list === value);
      } else {
        button.classList.toggle('active', !!formats[format]);
      }
    });
  }
  
  // Format button click handlers
  formatButtons.forEach(button => {
    button.addEventListener('click', () => {
      const format = button.dataset.format;
      const value = button.dataset.value;
      
      if (!quill) return;
      
      const range = quill.getSelection();
      if (!range) return;
      
      if (format === 'header') {
        // Toggle header - if already this header type, remove it
        if (quill.getFormat(range).header == value) {
          quill.format('header', false);
        } else {
          quill.format('header', value);
        }
      } else if (format === 'list') {
        // Toggle list - if already this list type, remove it
        if (quill.getFormat(range).list === value) {
          quill.format('list', false);
        } else {
          quill.format('list', value);
        }
      } else {
        // Toggle basic format (bold, italic)
        const currentValue = quill.getFormat(range)[format];
        quill.format(format, !currentValue);
      }
      
      // Update button states
      updateFormatButtons(quill, range);
    });
  });

  // Make title editable
  if (typeof meetingTitle !== 'undefined' && meetingTitle) {
    meetingTitle.addEventListener('focus', () => {
      // Store the original content to restore selected spans
      meetingTitle.dataset.original = meetingTitle.innerHTML;
    });
    meetingTitle.addEventListener('blur', () => {
      // Ensure company and template labels are preserved
      if (!meetingTitle.textContent.trim()) {
        meetingTitle.innerHTML = meetingTitle.dataset.original || 'Meeting';
      } else if ((typeof companyLabel !== 'undefined' && companyLabel && !meetingTitle.contains(companyLabel)) || (typeof templateLabel !== 'undefined' && templateLabel && !meetingTitle.contains(templateLabel))) {
        // If user removed the spans, restore them
        meetingTitle.innerHTML = `Meeting <span id="companyLabel">${companyLabel ? companyLabel.textContent : ''}</span> for a <span id="templateLabel">${templateLabel ? templateLabel.textContent : ''}</span>`;
      }
    });
  }

  // Wire up window control buttons
  if (windowCloseBtn) {
    windowCloseBtn.addEventListener('click', () => {
      window.close();
    });
  }
  if (windowMinBtn) {
    windowMinBtn.addEventListener('click', () => {
      if (ipcRenderer) ipcRenderer.invoke('minimize-window');
    });
  }
  if (windowMaxBtn) {
    windowMaxBtn.addEventListener('click', () => {
      if (ipcRenderer) ipcRenderer.invoke('maximize-window');
    });
  }

  // Handle IPC error events
  ipcRenderer.on('open-meeting-overlay-error', (event, data) => {
    console.error('[meetingOverlay.js] Received error:', data.error);
    alert(`Error: ${data.error}`);
  });
  
  // Handle click outside format bar to hide it
  document.addEventListener('click', (e) => {
    if (!formatBar.contains(e.target) && !quillEditorDiv.contains(e.target)) {
      hideFormatBar();
    }
  });

  // Add event delegation for checklist actions in the outline section
  outlineTabContent.addEventListener('click', (event) => {
    const checkBtn = event.target.closest('.checklist-btn-check');
    const xBtn = event.target.closest('.checklist-btn-x');
    if (checkBtn) {
      const item = checkBtn.closest('.checklist-item');
      const label = item.querySelector('.checklist-label');
      label.classList.toggle('checked');
      // Optionally, visually disable the buttons after checking
      // checkBtn.disabled = true;
      // xBtn = item.querySelector('.checklist-btn-x');
      // if (xBtn) xBtn.disabled = true;
    } else if (xBtn) {
      const item = xBtn.closest('.checklist-item');
      if (item) item.remove();
    }
  });

  const recordBtn = document.getElementById('recordBtn');
  let isRecording = false;
  let isTranscribing = false;
  let transcriptionReady = false;
  let isEnhancing = false;
  let enhancementReady = false;

  // Helper to update the record/enhance button UI
  function updateRecordButton() {
    if (isEnhancing) {
      recordBtn.disabled = true;
      recordBtn.innerHTML = '<span>Enhancing...</span>';
      return;
    }
    if (transcriptionReady) {
      recordBtn.disabled = false;
      recordBtn.classList.remove('recording');
      recordBtn.innerHTML = '<span>Enhance</span>';
      recordBtn.title = 'Enhance meeting notes with AI';
      return;
    }
    if (isRecording) {
      recordBtn.disabled = false;
      recordBtn.classList.add('recording');
      recordBtn.innerHTML = '<span>Stop</span>';
      recordBtn.title = 'Stop Recording';
      return;
    }
    if (isTranscribing) {
      recordBtn.disabled = true;
      recordBtn.classList.remove('recording');
      recordBtn.innerHTML = '<span>Transcribing...</span>';
      recordBtn.title = 'Transcribing audio...';
      return;
    }
    // Default: ready to record
    recordBtn.disabled = false;
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='#fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' class='lucide lucide-mic'><path d='M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z'></path><path d='M19 10v2a7 7 0 0 1-14 0v-2'></path><line x1='12' x2='12' y1='19' y2='22'></line></svg>`;
    recordBtn.title = 'Record Audio';
  }

  // Initial state
  updateRecordButton();

  // Record button click handler
  recordBtn.addEventListener('click', async () => {
    if (isEnhancing) return;
    if (transcriptionReady) {
      // Enhance button pressed
      isEnhancing = true;
      updateRecordButton();
      try {
        // Call enhance meeting content edge function
        const meetingId = getCurrentMeetingId();
        if (!meetingId) throw new Error('No meeting in progress');
        const res = await ipcRenderer.invoke('enhance-meeting-content', meetingId);
        if (res.success && res.content) {
          // Update the note editor (Quill)
          if (quill) {
            quill.setText('');
            quill.clipboard.dangerouslyPasteHTML(0, res.content);
          }
          enhancementReady = true;
        } else {
          alert('Failed to enhance meeting notes: ' + (res.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error enhancing meeting notes: ' + err.message);
      } finally {
        isEnhancing = false;
        updateRecordButton();
      }
      return;
    }
    if (!isRecording) {
      // Start recording
      const meetingId = getCurrentMeetingId();
      if (!meetingId) {
        alert('No meeting in progress');
        return;
      }
      // Set current meeting in main process before recording
      const setMeetingRes = await ipcRenderer.invoke('set-current-meeting', meetingId);
      if (!setMeetingRes.success) {
        alert('Failed to set meeting session: ' + setMeetingRes.error);
        return;
      }
      isRecording = true;
      updateRecordButton();
      try {
        await ipcRenderer.invoke('start-recording-audio');
      } catch (err) {
        isRecording = false;
        updateRecordButton();
        alert('Failed to start recording: ' + err.message);
      }
    } else {
      // Stop recording
      isRecording = false;
      isTranscribing = true;
      updateRecordButton();
      try {
        const meetingId = getCurrentMeetingId();
        if (!meetingId) throw new Error('No meeting in progress');
        
        // stopRecording (from recording.js, called via ipcHandlers)
        // now handles the entire lifecycle including initiating transcription.
        await ipcRenderer.invoke('stop-recording-audio');
        console.log('[meetingOverlay.js] stop-recording-audio invoked. Transcription should be initiated by main process.');
        
        // The following call is redundant as transcription is handled by the stop-recording-audio flow.
        // const res = await ipcRenderer.invoke('transcribe-meeting-audio', meetingId);
        // if (res.success) {
        //   transcriptionReady = true;
        // } else {
        //   alert('Transcription failed: ' + (res.error || 'Unknown error'));
        // }

        // Assuming transcription status will be updated via other means (e.g., WebSocket, polling if mishiService provides it)
        // For now, we can remove the direct alert for transcription failure here as it's handled by recording.js

      } catch (err) {
        // This error is for the stop-recording-audio invocation itself or meetingId issues.
        alert('Error stopping recording or initiating transcription: ' + err.message);
      } finally {
        isTranscribing = false; // This should be set based on actual transcription status updates from main
        updateRecordButton();
      }
    }

    if (typeof updateRecordBarVisibility === 'function') updateRecordBarVisibility();
  });

  // --- SIDEBAR BUTTON LOGIC ---
  const sidebarPrepareBtn = document.getElementById('sidebarPrepareBtn');
  const sidebarDiscussBtn = document.getElementById('sidebarDiscussBtn');
  const sidebarFollowupBtn = document.getElementById('sidebarFollowupBtn');
  const sidebarDarkModeBtn = document.getElementById('sidebarDarkModeBtn');
  const sidebarSettingsBtn = document.getElementById('sidebarSettingsBtn');
  const mainContentWrapper = document.getElementById('mainContentWrapper');

  // Helper to show/hide main panels
  function showMeetingSetup() {
    meetingSetup.style.display = '';
    meetingContent.style.display = 'none';
    updateCustomTitleBar(undefined, undefined, undefined, false);
    if (typeof updateRecordBarVisibility === 'function') updateRecordBarVisibility();
  }
  function showMeetingContent(company, template) {
    meetingSetup.style.display = 'none';
    meetingContent.style.display = 'block';
    updateCustomTitleBar(undefined, company, template, true);
    if (typeof updateRecordBarVisibility === 'function') updateRecordBarVisibility();
  }
});

function updateCustomTitleBar(meetingTitle, company, template, isMeetingCreated) {
  // Implementation of updateCustomTitleBar function
}

function updateRecordBarVisibility() {
  // Implementation of updateRecordBarVisibility function
}

function showMeetingContent(company, template) {
  meetingSetup.style.display = 'none';
  meetingContent.style.display = 'block';
  updateCustomTitleBar(undefined, company, template, true);
  if (typeof updateRecordBarVisibility === 'function') updateRecordBarVisibility();
}

function showMeetingSetup() {
  meetingSetup.style.display = '';
  meetingContent.style.display = 'none';
  updateCustomTitleBar(undefined, undefined, undefined, false);
  if (typeof updateRecordBarVisibility === 'function') updateRecordBarVisibility();
}
