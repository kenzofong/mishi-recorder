# Meeting Functionality Core Implementation Guide

This guide focuses on the core functionality needed to implement meeting features in the desktop app, detailing the data flows and API endpoints rather than specific UI implementation.

## Prerequisites

- Supabase authentication
- Database tables (meetings, companies, contacts, etc.)
- Basic CRUD operations

## 1. Core Meeting Preparation Functionality

### Fetch Company Information

```typescript
/**
 * Retrieves company details for meeting preparation
 * 
 * @param companyId - The ID of the company
 * @returns Company data including name, description, and summary
 */
const fetchCompanyInfo = async (companyId: string) => {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, description, summary, logo_url')
    .eq('id', companyId)
    .single();
  
  if (error) throw error;
  return data;
};
```

### Fetch Previous Meetings

```typescript
/**
 * Retrieves previous meetings associated with a company
 * 
 * @param companyId - The ID of the company
 * @returns Array of meetings with title, notes, and summaries
 */
const fetchPreviousMeetings = async (companyId: string) => {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('meetings')
    .select('id, title, notes, tldr, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  
  if (error) throw error;
  return data || [];
};
```

### Fetch Associated Documents

```typescript
/**
 * Retrieves documents associated with a company
 * 
 * @param workspaceId - The ID of the workspace
 * @param companyId - The ID of the company
 * @returns Array of documents with title and content
 */
const fetchCompanyDocuments = async (workspaceId: string, companyId: string) => {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, content, metadata, created_at')
    .eq('company_id', companyId)
    .eq('workspace_id', workspaceId);
  
  if (error) throw error;
  return data || [];
};
```

### Fetch Company Contacts

```typescript
/**
 * Retrieves contacts associated with a company
 * 
 * @param companyId - The ID of the company
 * @returns Array of contacts with names and job functions
 */
const fetchCompanyContacts = async (companyId: string) => {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email, job_functions')
    .eq('company_id', companyId);
    
  if (error) throw error;
  return data || [];
};
```

## 2. Meeting Preparation Edge Function

### Edge Function: meeting-context

**Purpose**: Build a comprehensive context object for a meeting that can be used by other edge functions.

**Endpoint**: `supabase.functions.invoke('meeting-context', { body: { meetingId } })`

**Input**:
```typescript
{
  meetingId: string;
}
```

**Output**:
```typescript
{
  meeting: {
    id: string;
    title: string;
    notes: string;
    created_at: string;
    workspace_id: string;
    company_id: string | null;
  };
  company: {
    id: string;
    name: string;
    description: string;
    summary: string;
  } | null;
  previousMeetings: Array<{
    id: string;
    title: string;
    notes: string;
    tldr: string | null;
    created_at: string;
  }>;
  documents: Array<{
    id: string;
    title: string;
    content: string;
    created_at: string;
  }>;
  contacts: Array<{
    id: string;
    first_name: string;
    last_name: string;
    job_functions: string | null;
    email: string;
  }>;
  attendees: Array<{
    id: string;
    name: string;
    email: string;
    type: string;
  }>;
  transcription?: string | null;
  sentiment_analysis?: Array<{
    text: string;
    sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
    confidence: number;
  }> | null;
  topics?: Array<{
    topic: string;
    confidence: number;
  }> | null;
  key_phrases?: Array<{
    phrase: string;
    count: number;
    rank: number;
  }> | null;
}
```

**Implementation Notes**:
- Fetches all context data from the database in one request
- Uses Supabase auth to verify the user has access to the meeting
- Retrieves data only from the user's workspace
- Caches responses to avoid regenerating the same data frequently

### Edge Function: generate-meeting-prep

**Purpose**: Generate structured preparation content for an upcoming meeting.

**Endpoint**: `supabase.functions.invoke('generate-meeting-prep', { body: { meetingId } })`

**Input**:
```typescript
{
  meetingId: string;
}
```

**Output**:
```typescript
{
  content: string; // JSON string with the following structure when parsed:
  // {
  //   "summary": string, // Markdown-formatted summary of key information
  //   "agenda": string[], // Suggested agenda items as array of strings
  //   "open_questions": string[] // Follow-up questions from previous meetings
  // }
}
```

**Implementation Notes**:
- Calls `meeting-context` internally to gather all relevant data
- Uses an LLM (Groq, OpenAI, etc.) to generate structured content
- Handles cleaning and formatting of the response
- Stores the result in the `meeting_prep` column of the `meetings` table
- Also stores the parsed agenda and questions in separate columns if valid JSON

## 3. During Meeting Functionality

### Parse Meeting Preparation Content

```typescript
/**
 * Parses meeting preparation content from JSON string
 * 
 * @param prepContent - The raw meeting preparation content
 * @returns Parsed meeting preparation object or null
 */
const parseMeetingPrep = (prepContent: string | null): {
  summary: string;
  agenda: string[];
  open_questions: string[];
} | null => {
  if (!prepContent) return null;
  
  let content = prepContent.trim();
  // Strip code fences if present
  if (content.startsWith('```') && content.endsWith('```')) {
    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    console.error('Failed to parse meeting prep content:', e);
    return null;
  }
};
```

### Add User-Defined Agenda Items

```typescript
/**
 * Adds a user-defined agenda item to the meeting
 * 
 * @param meetingId - The ID of the meeting
 * @param item - The agenda item to add
 * @returns Updated agenda items array
 */
const addUserAgendaItem = async (meetingId: string, item: string) => {
  const supabase = await getSupabaseClient();
  
  // Get current user agenda items
  const { data: meeting } = await supabase
    .from('meetings')
    .select('user_agenda')
    .eq('id', meetingId)
    .single();
    
  // Update with new item
  const userAgenda = Array.isArray(meeting?.user_agenda) ? [...meeting.user_agenda, item] : [item];
  
  await supabase
    .from('meetings')
    .update({ user_agenda: userAgenda })
    .eq('id', meetingId);
    
  return userAgenda;
};
```

### Track Completed Agenda Items and Questions

```typescript
/**
 * Updates tracking of completed agenda items and questions
 * 
 * @param meetingId - The ID of the meeting
 * @param completedAgenda - Array of completed agenda item indices
 * @param completedQuestions - Array of completed question indices
 */
const updateCompletedItems = async (
  meetingId: string, 
  completedAgenda: number[], 
  completedQuestions: number[]
) => {
  const supabase = await getSupabaseClient();
  
  await supabase
    .from('meetings')
    .update({
      completed_agenda: completedAgenda,
      completed_questions: completedQuestions
    })
    .eq('id', meetingId);
};
```

## 4. After Meeting Functionality

### Add Meeting Attendees

```typescript
/**
 * Adds an attendee to the meeting
 * 
 * @param meetingId - The ID of the meeting
 * @param attendee - The attendee object
 * @returns The created attendee record
 */
const addMeetingAttendee = async (meetingId: string, attendee: { 
  id?: string;
  name: string;
  email: string;
  type: 'member' | 'contact' | 'company' | 'unknown';
}) => {
  const supabase = await getSupabaseClient();
  
  // Handle different attendee types
  if (attendee.type === 'unknown') {
    // External attendee
    const { data, error } = await supabase
      .from('meeting_attendees')
      .insert({
        meeting_id: meetingId,
        external_name: attendee.name,
        external_email: attendee.email,
        attendee_type: 'external'
      })
      .select()
      .single();
      
    if (error) throw error;
    return data;
  } else {
    // Internal attendee (member, contact, etc.)
    const { data, error } = await supabase
      .from('meeting_attendees')
      .insert({
        meeting_id: meetingId,
        user_id: attendee.id,
        attendee_type: attendee.type
      })
      .select()
      .single();
      
    if (error) throw error;
    return data;
  }
};
```

### Enhance Meeting Notes

```typescript
/**
 * Enhances meeting notes with the help of an LLM
 * 
 * @param meetingId - The ID of the meeting
 * @param currentNotes - The current meeting notes
 * @returns Stream of enhanced notes content
 */
const enhanceMeetingNotes = async (meetingId: string, currentNotes: string) => {
  const supabase = await getSupabaseClient();
  
  // First, get the meeting context
  const contextResponse = await supabase.functions.invoke('meeting-context', {
    body: { meetingId }
  });
  
  if (contextResponse.error) throw new Error(contextResponse.error.message);
  
  const context = {
    ...contextResponse.data,
    notes: currentNotes,
  };
  
  // Call the generate-meeting-content endpoint with streaming
  return supabase.functions.invoke('generate-meeting-content', {
    body: { input: context }
  });
};
```

### Edge Function: generate-meeting-content

**Purpose**: Generate enhanced meeting notes based on meeting context.

**Endpoint**: `supabase.functions.invoke('generate-meeting-content', { body: { input } })`

**Input**:
```typescript
{
  input: {
    // Meeting context from meeting-context function
    meeting: { /* ... */ },
    company: { /* ... */ },
    attendees: [ /* ... */ ],
    transcription: string | null,
    sentiment_analysis: Array<{ /* ... */ }> | null,
    topics: Array<{ /* ... */ }> | null,
    key_phrases: Array<{ /* ... */ }> | null,
    // Current notes
    notes: string
  }
}
```

**Output**: 
- Returns a stream of text chunks that should be concatenated to form the enhanced notes
- Stream format: Server-sent events with JSON data containing `content` property
- Final event: `data: [DONE]`

**Implementation Notes**:
- Uses streaming response to provide real-time updates
- Leverages the transcription data if available
- Analyzes sentiment, topics, and key phrases
- Structures notes with proper formatting (headings, bullet points)
- Preserves important information from the original notes
- Automatically saves the final version to the database

### Create Follow-ups

```typescript
/**
 * Creates a follow-up task from a meeting
 * 
 * @param followUp - The follow-up details
 * @returns The created follow-up record
 */
const createFollowUp = async (followUp: {
  meeting_id: string;
  company_id?: string | null;
  description: string;
  due_date?: string | null;
  assigned_to?: string | null;
}) => {
  const supabase = await getSupabaseClient();
  
  const { data, error } = await supabase
    .from('follow_ups')
    .insert({
      ...followUp,
      status: 'pending',
      created_at: new Date().toISOString()
    })
    .select()
    .single();
    
  if (error) throw error;
  return data;
};
```

## 5. Chat with Meeting Context

### Edge Function: meeting-chat-with-context

**Purpose**: Provide conversational assistance during or after meetings.

**Endpoint**: `supabase.functions.invoke('meeting-chat-with-context', { body: { meetingId, message, chatHistory } })`

**Input**:
```typescript
{
  meetingId: string;
  message: string;
  context?: object; // Optional additional context
  chatHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}
```

**Output**:
- Returns a stream of text chunks from the assistant
- Stream format: Server-sent events with JSON data containing `content` property
- Final event: `data: [DONE]`

**Implementation Notes**:
- Automatically fetches meeting context using the meeting-context function
- Maintains conversation history for coherent multi-turn interactions
- Uses an LLM to generate helpful, contextually relevant responses
- Saves chat history to the database for future reference
- Focuses responses on meeting-relevant information

## Database Schema

The implementation requires the following key tables:

1. `meetings`
   - id (UUID)
   - workspace_id (UUID)
   - company_id (UUID, nullable)
   - title (text)
   - notes (text)
   - transcription (text, nullable)
   - sentiment_analysis (JSONB, nullable)
   - topics (JSONB, nullable)
   - key_phrases (JSONB, nullable)
   - meeting_prep (text, nullable)
   - user_agenda (JSONB, nullable)
   - completed_agenda (JSONB, nullable)
   - completed_questions (JSONB, nullable)
   - created_at (timestamp)
   - updated_at (timestamp)
   - created_by (UUID)

2. `meeting_attendees`
   - id (UUID)
   - meeting_id (UUID)
   - user_id (UUID, nullable)
   - external_name (text, nullable)
   - external_email (text, nullable)
   - attendee_type (text)
   - created_at (timestamp)

3. `meeting_context_snapshots`
   - id (UUID)
   - meeting_id (UUID)
   - user_id (UUID)
   - context (JSONB)
   - created_at (timestamp)

4. `follow_ups`
   - id (UUID)
   - meeting_id (UUID)
   - company_id (UUID, nullable)
   - description (text)
   - due_date (timestamp, nullable)
   - assigned_to (UUID, nullable)
   - status (text)
   - created_at (timestamp)
   - updated_at (timestamp)

5. `chat_messages`
   - id (UUID)
   - meeting_id (UUID)
   - user_id (UUID)
   - message (text)
   - response (text)
   - created_at (timestamp)

## Performance Considerations

1. **Context Caching**
   - Use `meeting_context_snapshots` to cache context data
   - Implement a function to get the latest snapshot or regenerate if needed:
     ```typescript
     const getMeetingContext = async (meetingId) => {
       // Try to get recent snapshot (< 5 minutes old)
       const { data } = await supabase
         .from('meeting_context_snapshots')
         .select('context')
         .eq('meeting_id', meetingId)
         .gt('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
         .order('created_at', { ascending: false })
         .limit(1)
         .maybeSingle();
         
       if (data?.context) return data.context;
       
       // Generate new context
       const { data: newContext } = await supabase.functions.invoke('meeting-context', {
         body: { meetingId }
       });
       
       // Save new snapshot
       await supabase.from('meeting_context_snapshots').insert({
         meeting_id: meetingId,
         user_id: currentUser.id,
         context: newContext
       });
       
       return newContext;
     };
     ```

2. **Rate Limiting**
   - Implement throttling for LLM-dependent functions
   - Provide feedback to users during processing

3. **Streaming Responses**
   - Use streaming for all LLM-generated content
   - Implement a reusable helper for handling streaming:
     ```typescript
     const handleStreamingResponse = async (response, onChunk, onComplete) => {
       const reader = response.body.getReader();
       const decoder = new TextDecoder();
       let done = false;
       let accumulated = '';
       
       while (!done) {
         const { value, done: readerDone } = await reader.read();
         done = readerDone;
         
         if (value) {
           const chunk = decoder.decode(value, { stream: true });
           const lines = chunk.split('\n').filter(line => line.trim() !== '');
           
           for (const line of lines) {
             if (line.startsWith('data: ')) {
               const content = line.substring(6).trim();
               
               if (content === '[DONE]') {
                 done = true;
                 break;
               }
               
               try {
                 const parsed = JSON.parse(content);
                 if (parsed.content) {
                   accumulated += parsed.content;
                   onChunk(parsed.content, accumulated);
                 }
               } catch (e) {
                 console.error('Failed to parse stream chunk:', e);
               }
             }
           }
         }
       }
       
       onComplete(accumulated);
     };
     