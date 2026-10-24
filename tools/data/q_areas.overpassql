[out:json][timeout:240];
(
  way["leisure"~"^(park|garden|pitch|golf_course|stadium|playground)$"](25.012,121.492,25.085,121.582);
  relation["leisure"~"^(park|garden|golf_course)$"](25.012,121.492,25.085,121.582);
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|railway)$"](25.012,121.492,25.085,121.582);
  relation["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"](25.012,121.492,25.085,121.582);
  way["natural"~"^(water|wood|scrub|grassland)$"](25.012,121.492,25.085,121.582);
  relation["natural"~"^(water|wood|scrub)$"](25.012,121.492,25.085,121.582);
  way["waterway"~"^(river|canal|riverbank)$"](25.012,121.492,25.085,121.582);
  way["aeroway"~"^(runway|taxiway|apron)$"](25.012,121.492,25.085,121.582);
  way["amenity"="parking"](25.012,121.492,25.085,121.582);
);
out geom;
