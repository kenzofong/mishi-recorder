window.addEventListener('DOMContentLoaded', () => {
  console.log('[recordingBar.js] loaded');
  const ipcRenderer = window.electron.ipcRenderer;

  const recordBtn = document.getElementById('recordBtn');
  
  let isRecording = false;

  function setRecordingState(recording) {
    isRecording = recording;
    if (isRecording) {
      recordBtn.classList.add('recording');
      recordBtn.classList.remove('selected');
      recordBtn.innerHTML = `
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="8" y="8" width="8" height="8" rx="2"/></svg>
        Stop
      `;
      recordBtn.style.background = '#ff3b30';
      recordBtn.style.color = '#fff';
    } else {
      recordBtn.classList.remove('recording');
      recordBtn.classList.add('selected');
      recordBtn.innerHTML = `
        <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>
        Record
      `;
      recordBtn.style.background = '';
      recordBtn.style.color = '';
    }
  }

  // Initial state
  setRecordingState(false);

  recordBtn.addEventListener('click', () => {
    if (isRecording) {
      ipcRenderer.send('stop-recording');
    } else {
      ipcRenderer.send('start-recording');
    }
  });

  ipcRenderer.on('recording-state-change', (event, recording) => {
    console.log('[recordingBar.js] Received recording-state-change:', recording);
    setRecordingState(recording);
  });

  // --- Meeting Dialog Logic ---
  const meetingBtn = document.getElementById('meetingBtn');
  const meetingDialog = document.getElementById('meetingDialog');
  const companySelect = document.getElementById('companySelect');
  const templateSelect = document.getElementById('templateSelect');
  const startMeetingBtn = document.getElementById('startMeetingBtn');
  console.log('startMeetingBtn:', startMeetingBtn);
  const closeMeetingDialog = document.getElementById('closeMeetingDialog');
  const companyLabel = document.getElementById('companyLabel');
  const templateLabel = document.getElementById('templateLabel');
  const meetingOverlay = document.getElementById('meetingOverlay');

  let templatesMap = {};

  function showMeetingDialog() {
    meetingDialog.style.display = 'flex';
    // Fetch companies and templates
    ipcRenderer.invoke('get-companies').then(res => {
      if (res.success) {
        companySelect.innerHTML = res.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        if (res.companies.length > 0) {
          companyLabel.textContent = res.companies[0].name;
        }
      } else {
        companySelect.innerHTML = '<option value="">No companies</option>';
        companyLabel.textContent = '[company]';
      }
    });
    ipcRenderer.invoke('get-meeting-templates').then(res => {
      console.log('[Meeting Templates Response]', res);
      if (res.success) {
        templatesMap = {};
        templateSelect.innerHTML = res.templates.map(t => {
          templatesMap[t.id] = t;
          return `<option value="${t.id}">${t.name}</option>`;
        }).join('');
        if (res.templates.length > 0) {
          templateLabel.textContent = res.templates[0].name;
        }
      } else {
        templateSelect.innerHTML = '<option value="">No templates</option>';
        templateLabel.textContent = '[template]';
      }
    });
  }

  meetingBtn.addEventListener('click', () => {
    // Open overlay window for meeting setup/editor
    ipcRenderer.send('open-meeting-overlay', {
      company: '',
      template: '',
      content: ''
    });
  });

  companySelect.addEventListener('change', () => {
    const selected = companySelect.options[companySelect.selectedIndex];
    companyLabel.textContent = selected ? selected.textContent : '[company]';
  });
  templateSelect.addEventListener('change', () => {
    const selected = templateSelect.options[templateSelect.selectedIndex];
    templateLabel.textContent = selected ? selected.textContent : '[template]';
  });

  closeMeetingDialog.addEventListener('click', () => {
    meetingDialog.style.display = 'none';
  });

  startMeetingBtn.addEventListener('click', () => {
    const companyId = companySelect.value;
    const templateId = templateSelect.value;
    if (!companyId || !templateId) return;
    meetingDialog.style.display = 'none';
    const companyName = companySelect.options[companySelect.selectedIndex]?.textContent || '';
    const templateName = templateSelect.options[templateSelect.selectedIndex]?.textContent || '';
    const template = templatesMap[templateId];
    const content = template ? template.content : '';
    console.log('[recordingBar.js] Sending open-meeting-overlay IPC', { company: companyName, template: templateName, content });
    ipcRenderer.send('open-meeting-overlay', {
      company: companyName,
      template: templateName,
      content
    });
  });

  function showMeetingOverlay(content) {
    // Clear overlay
    meetingOverlay.innerHTML = '';
    // Add title bar
    const titleBar = document.createElement('div');
    titleBar.style.fontSize = '18px';
    titleBar.style.fontWeight = '600';
    titleBar.style.background = '#f7f7f7';
    titleBar.style.padding = '18px 24px 10px 24px';
    titleBar.style.borderRadius = '12px 12px 0 0';
    titleBar.style.borderBottom = '1px solid #eee';
    titleBar.style.color = '#222';
    // Get selected company/template names
    const companyName = companySelect.options[companySelect.selectedIndex]?.textContent || '';
    const templateName = templateSelect.options[templateSelect.selectedIndex]?.textContent || '';
    titleBar.textContent = `Meeting ${companyName} for a ${templateName}`;
    meetingOverlay.appendChild(titleBar);
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '10px';
    closeBtn.style.right = '16px';
    closeBtn.style.background = 'none';
    closeBtn.style.border = 'none';
    closeBtn.style.fontSize = '22px';
    closeBtn.style.color = '#888';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.zIndex = '10';
    closeBtn.addEventListener('click', hideMeetingOverlay);
    meetingOverlay.appendChild(closeBtn);
    // Add editor container
    const editorDiv = document.createElement('div');
    editorDiv.id = 'quillEditor';
    editorDiv.style.height = '260px';
    editorDiv.style.minHeight = '260px';
    editorDiv.style.width = 'calc(100% - 48px)';
    editorDiv.style.margin = '24px';
    meetingOverlay.appendChild(editorDiv);
    // Show and animate overlay
    meetingOverlay.style.display = 'block';
    setTimeout(() => {
      meetingOverlay.style.transform = 'translateX(-50%) translateY(0)';
    }, 10);
    // Initialize Quill
    setTimeout(() => {
      const quill = new window.Quill('#quillEditor', {
        theme: 'snow',
        modules: {
          toolbar: [
            [{ header: [1, 2, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['link'],
            ['clean']
          ]
        }
      });
      quill.root.innerHTML = content || '';
    }, 50);
  }

  function hideMeetingOverlay() {
    meetingOverlay.style.transform = 'translateX(-50%) translateY(40px)';
    setTimeout(() => {
      meetingOverlay.style.display = 'none';
      meetingOverlay.innerHTML = '';
    }, 350);
  }
}); 