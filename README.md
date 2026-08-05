#  ISS Track

International space station tracker app built with HTML, CSS and JavaScript. Shows the current position of the ISS on an interactive world map based on a public API endpoint

[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000)](#)
[![CSS](https://img.shields.io/badge/CSS-639?logo=css&logoColor=fff)](#)
![Status](https://img.shields.io/badge/status-active-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

##  Features

* Interactive world map
* Tracking the international space station
* Display latitude and longitude of the ISS
* Showing the last update timestamp
* Refreshing every few seconds
* Responsive design
* NASA themed UI

##  Tech stack

HTML5, CSS3, JavaScript (ES6), Leaflet.js, OpenStreetMap, Open Notify ISS API

##  Preview
Map:
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/2c2f9831-f921-445c-8b1a-d4072eef2cd5" />

Globe:
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/45c145e8-9499-4705-8b3f-b7ee266f4085" />


##  Getting Started

Clone the repo:
```bash
git clone https://github.com/akisarke/isstrack.git
```
Open the project folder:
```bash
cd isstrack
```
To launch the app, open index.html directly in the browser or use a local server (for example):
```bash
python -m http.server
```
Then navigate to [http://localhost:8000](http://localhost:8000) or visit [my site](https://iss.akisarke.xyz).

##  Project structure
```text
isstrack/
├── js
  ├── javascript scripts
├── app.js
├── CNAME
├── index.html
├── package.json
├── README.md
├── script.js
├── style.css
```

##  How It Works

1. The application retrieves the current coordinates of the ISS from a public API
2. The response from the API contains the latitude and longitude of the ISS
3. The map marker is updated with the new coordinates
4. The position of the ISS is updated every few seconds

##  AI Notice

The UI and some code checking is the only bit of my project that AI helped me with.

##  License

This project is licensed under the MIT License.

