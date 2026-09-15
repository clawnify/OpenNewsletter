-- Synthetic demo data only. No connected sender or scheduled deliveries.
INSERT INTO audiences (id, name, description) VALUES
  ('audience-team-updates', 'Team updates', 'Sample readers for the Northline weekly update.');
INSERT INTO settings (id, publication_name, from_name, default_audience_id, footer_text) VALUES
  (1, 'The Northline Edit', 'Northline Studio', 'audience-team-updates', 'A sample publication. All people and addresses in this demo are fictional.');
INSERT INTO contacts (id, audience_id, email, first_name, last_name, status, consent_source, consent_evidence) VALUES
  ('reader-alex', 'audience-team-updates', 'alex@northline.example', 'Alex', 'Morgan', 'subscribed', 'manual', 'Fictional opt-in used only to demonstrate audience management.'),
  ('reader-riley', 'audience-team-updates', 'riley@northline.example', 'Riley', 'Park', 'pending', 'manual', ''),
  ('reader-casey', 'audience-team-updates', 'casey@northline.example', 'Casey', 'Rivera', 'unsubscribed', 'manual', 'Fictional unsubscribe example.');
INSERT INTO mails (title, eyebrow, subtitle, byline_name, byline_date, blocks, audience_id, status) VALUES
  ('One place for every client update', 'THE NORTHLINE EDIT', 'A calmer way to keep projects moving.', 'Alex Morgan', date('now'),
   '[{"id":"welcome-title","type":"heading","level":1,"text":"One place for every client update"},{"id":"welcome-intro","type":"text","md":"This week we brought project updates, approvals and next steps into one client workspace. Here is what changed for the team."},{"id":"welcome-list","type":"list","ordered":false,"items":["Clients can find the latest project update in one place.","Approvals have a clear owner and due date.","The team spends less time answering status questions."]},{"id":"welcome-close","type":"text","md":"What is one repeat question you could answer inside your client workspace?"}]',
   'audience-team-updates', 'draft'),
  ('Three ideas for a better handoff', 'FIELD NOTES', 'Small changes that help the next person start.', 'Northline Studio', date('now'),
   '[{"id":"handoff-title","type":"heading","level":1,"text":"Three ideas for a better handoff"},{"id":"handoff-intro","type":"text","md":"A good handoff tells the next person what is finished, what is waiting and where to find the details."},{"id":"handoff-list","type":"list","ordered":true,"items":["Write down the next action.","Link the source document.","Name the person responsible."]}]',
   'audience-team-updates', 'draft');
