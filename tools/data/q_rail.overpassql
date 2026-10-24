[out:json][timeout:240];
(
  way["railway"~"^(subway|rail|light_rail|monorail)$"](25.012,121.492,25.085,121.582);
  node["railway"="station"](25.012,121.492,25.085,121.582);
  node["station"="subway"](25.012,121.492,25.085,121.582);
);
out geom;
