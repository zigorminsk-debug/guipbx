package main

import "testing"

func TestNormalizeHost(t *testing.T) {
	cases := map[string]string{
		"192.168.100.254":                        "192.168.100.254",
		"http://192.168.100.254/admin/config.php#": "192.168.100.254",
		"https://pbx.office.local:8080/panel":      "pbx.office.local",
		"  10.0.0.5:5038  ":                        "10.0.0.5",
		"pbx.local":                              "pbx.local",
		"pbx.local:5038":                         "pbx.local",
		"":                                     "",
	}
	for in, want := range cases {
		if got := normalizeHost(in); got != want {
			t.Errorf("normalizeHost(%q) = %q, ожидалось %q", in, got, want)
		}
	}
}
