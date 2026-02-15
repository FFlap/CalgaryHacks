# Clarify

# Inspiration

As students constantly conducting research, we found it increasingly difficult to distinguish truth from fabrication and bias in today's information era. We realized that in the age of information overload, discerning credible sources from noise is a massive pain point. We asked ourselves: How can we make it easier to figure out the truth among the vast misinformation on the internet?

# What it does

Clarity is a browser extension that works on both web pages and YouTube videos. It checks each sentence and verifies it with trusted sources, categorizing findings into three distinct tabs: Misinformation, Fallacies ,Bias Information. The purpose of this project is to make it easier for people to figure out the truth among the vast misinformation on the internet.

# How we built it

To ground our framework, we used a commonly used pre-built framework from WXT to get most of the functionality from a browser extension working. Then, we used shadcn to create a modern UI aesthetic. For our backend, we utilized Typescript alongside the WXT framework to make the product one of a kind. For our AI agent, we use OpenRouter to grab various open-source models so that data says private, and not give one specific agent sensitive data. We also routed in Wikipedia/Wikimedia API, Google's Fact Check API, PubMed API, and other smaller fact checking APIs to have the best results when looking for trusted sources on the page.

# Challenges we ran into

The YouTube Hurdle: Extracting clean, timestamped transcripts from YouTube's API to ensure the fact-checking synced perfectly with the video playback. Ad-Filtering: Building logic to bypass advertisements, and recommendation so the AI only analyzes the core content. Verification Accuracy: To ensure we weren't flagging legitimate opinions as misinformation while still catching subtle falsehoods.

# Accomplishments that we're proud of

We successfully synthesized multiple, often fragmented, fact-checking APIs into a single, cohesive dashboard. Creating a tool that can analyze a scientific paper via PubMed and a YouTube video in the same interface.

# What we learned

We gained deep insights into the architecture of modern misinformation. Using AI agent and cross reference data to verify the information.

# What's next for Clarity

Refining our backend logic to reduce latency in real-time video analysis also improving the sources for higher accuracy detection.

